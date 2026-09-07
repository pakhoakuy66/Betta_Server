import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  Error as MongooseError,
  type Model,
  Types,
} from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../admin/constants/admin-account.constants';
import {
  ADMIN_AUDIT_CORRELATION_ID_PATTERN,
  ADMIN_AUDIT_REASON_CODE_PATTERN,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../admin/constants/admin-audit.constants';
import {
  AdminPermission,
  hasAdminPermission,
} from '../admin/constants/admin-permission.constants';
import { type AdminAuditActorInput } from '../admin/interfaces/admin-audit.interface';
import { AdminAccount } from '../admin/schemas/admin-account.schema';
import { AdminSession } from '../admin/schemas/admin-session.schema';
import { AdminAuditService } from '../admin/services/admin-audit.service';
import {
  isAdminRequestPrincipal,
  type AdminRequestPrincipal,
} from '../admin/types/admin-authenticated-request';
import {
  SPONSORED_CLOCK,
  SPONSORED_PUBLIC_ID_PATTERN,
  SponsoredAssetHealth,
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from './sponsored-post.constants';
import { toPublicSponsoredPost } from './sponsored-post.mapper';
import {
  nextSponsoredStatus,
  normalizeSponsoredDraft,
  type SponsoredDraftInput,
} from './sponsored-post.policy';
import {
  SPONSORED_WRITE,
  SponsoredPost,
  type SponsoredPostDocument,
} from './sponsored-post.schema';

export type SponsoredMutationContext = Readonly<{
  reasonCode: string;
  correlationId?: string;
}>;
const permissions: Readonly<Record<Action, AdminPermission>> = {
  [Action.SCHEDULE]: AdminPermission.SPONSORED_POSTS_SCHEDULE,
  [Action.RETURN_TO_DRAFT]: AdminPermission.SPONSORED_POSTS_SCHEDULE,
  [Action.ACTIVATE]: AdminPermission.SPONSORED_POSTS_SCHEDULE,
  [Action.PAUSE]: AdminPermission.SPONSORED_POSTS_PAUSE,
  [Action.RESUME]: AdminPermission.SPONSORED_POSTS_PAUSE,
  [Action.EXPIRE]: AdminPermission.SPONSORED_POSTS_SCHEDULE,
  [Action.DELETE]: AdminPermission.SPONSORED_POSTS_DELETE,
  [Action.RESTORE]: AdminPermission.SPONSORED_POSTS_RESTORE,
};
const auditActions: Readonly<Record<Action, AdminAuditAction>> = {
  [Action.SCHEDULE]: AdminAuditAction.SPONSORED_SCHEDULED,
  [Action.RETURN_TO_DRAFT]: AdminAuditAction.SPONSORED_UPDATED,
  [Action.ACTIVATE]: AdminAuditAction.SPONSORED_ACTIVATED,
  [Action.PAUSE]: AdminAuditAction.SPONSORED_PAUSED,
  [Action.RESUME]: AdminAuditAction.SPONSORED_RESUMED,
  [Action.EXPIRE]: AdminAuditAction.SPONSORED_EXPIRED,
  [Action.DELETE]: AdminAuditAction.SPONSORED_DELETED,
  [Action.RESTORE]: AdminAuditAction.SPONSORED_RESTORED,
};

/** Internal domain API. Do not bind these arguments directly to HTTP request bodies. */
@Injectable()
export class SponsoredPostWriterService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly sessions: Model<AdminSession>,
    private readonly audit: AdminAuditService,
    @Inject(SPONSORED_CLOCK) private readonly clock: () => Date,
  ) {}

  async createDraft(
    actor: AdminRequestPrincipal,
    input: SponsoredDraftInput,
    context: SponsoredMutationContext,
  ) {
    this.assertActor(actor, AdminPermission.SPONSORED_POSTS_CREATE);
    this.assertContext(context);
    const draft = normalizeSponsoredDraft(input);
    return this.connection.transaction(
      async (session) => {
        await this.assertLiveActor(actor, session);
        if (draft.endAt.getTime() <= this.now().getTime()) {
          throw new BadRequestException('SPONSORED_SCHEDULE_ENDED');
        }
        const post = new this.posts({
          ...draft,
          ownerPublicId: actor.publicId,
        });
        post.$locals.sponsoredWrite = SPONSORED_WRITE;
        post.$session(session);
        await post.save();
        await this.audit.record({
          action: AdminAuditAction.SPONSORED_CREATED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: this.auditActor(actor, AdminPermission.SPONSORED_POSTS_CREATE),
          target: {
            type: AdminAuditTargetType.SPONSORED_POST,
            publicId: post.publicId,
          },
          reasonCode: context.reasonCode,
          correlationId: context.correlationId,
          metadata: { afterVersion: post.version, afterState: post.status },
          source: AdminAuditSource.HTTP,
          mongoSession: session,
        });
        return toPublicSponsoredPost(post);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  }

  async transition(
    actor: AdminRequestPrincipal,
    publicId: string,
    expectedVersion: number,
    operation: Action,
    context: SponsoredMutationContext,
  ) {
    this.assertTarget(publicId, expectedVersion);
    this.assertContext(context);
    if (
      operation === Action.EXPIRE ||
      !Object.values(Action).includes(operation)
    ) {
      throw new ForbiddenException('SPONSORED_OPERATION_NOT_ALLOWED');
    }
    const permission = permissions[operation];
    this.assertActor(actor, permission);
    return this.runTransition(
      publicId,
      expectedVersion,
      operation,
      context,
      this.auditActor(actor, permission),
      AdminAuditSource.HTTP,
      (session) => this.assertLiveActor(actor, session),
    );
  }

  /** Reserved for a trusted worker; this method is not exposed by a controller. */
  async transitionFromWorker(
    publicId: string,
    expectedVersion: number,
    operation: Action.ACTIVATE | Action.EXPIRE | Action.PAUSE,
  ) {
    this.assertTarget(publicId, expectedVersion);
    if (![Action.ACTIVATE, Action.EXPIRE, Action.PAUSE].includes(operation)) {
      throw new ForbiddenException('SPONSORED_WORKER_OPERATION_NOT_ALLOWED');
    }
    const reasonCode =
      operation === Action.PAUSE ? 'asset_unavailable' : 'schedule_boundary';
    return this.runTransition(
      publicId,
      expectedVersion,
      operation,
      { reasonCode },
      {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Sponsored lifecycle worker',
      },
      AdminAuditSource.WORKER,
    );
  }

  private async runTransition(
    publicId: string,
    expectedVersion: number,
    operation: Action,
    context: SponsoredMutationContext,
    actor: AdminAuditActorInput,
    source: AdminAuditSource,
    authorize?: (session: ClientSession) => Promise<void>,
  ) {
    try {
      return await this.connection.transaction(
        async (session) => {
          if (authorize) await authorize(session);
          const post = await this.posts
            .findOne({ publicId })
            .select('+ownerPublicId +assetHealth +statusReason')
            .session(session)
            .exec();
          if (!post) throw new NotFoundException('SPONSORED_POST_NOT_FOUND');
          if (post.version !== expectedVersion)
            throw new ConflictException('SPONSORED_VERSION_CONFLICT');
          if (
            source === AdminAuditSource.WORKER &&
            operation === Action.PAUSE &&
            ![
              SponsoredAssetHealth.MISSING,
              SponsoredAssetHealth.CORRUPT,
            ].includes(post.assetHealth)
          ) {
            throw new ConflictException(
              'SPONSORED_ASSET_FAILURE_NOT_CONFIRMED',
            );
          }
          const now = this.now();
          const beforeState = post.status;
          post.status = nextSponsoredStatus(post, operation, now);
          post.statusReason = context.reasonCode;
          post.deletedAt = post.status === Status.DELETED ? now : null;
          if (operation === Action.RESTORE)
            post.assetHealth = SponsoredAssetHealth.UNKNOWN;
          this.allowSave(post, session);
          await post.save();
          await this.audit.record({
            action: auditActions[operation],
            outcome: AdminAuditOutcome.SUCCEEDED,
            actor,
            target: { type: AdminAuditTargetType.SPONSORED_POST, publicId },
            reasonCode: context.reasonCode,
            correlationId: context.correlationId,
            metadata: {
              beforeVersion: expectedVersion,
              afterVersion: post.version,
              beforeState,
              afterState: post.status,
            },
            source,
            mongoSession: session,
          });
          return toPublicSponsoredPost(post);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } catch (error) {
      if (error instanceof MongooseError.VersionError) {
        throw new ConflictException('SPONSORED_VERSION_CONFLICT');
      }
      throw error;
    }
  }

  private allowSave(post: SponsoredPostDocument, session: ClientSession): void {
    post.$locals.sponsoredWrite = SPONSORED_WRITE;
    post.$session(session);
  }

  private assertActor(
    actor: AdminRequestPrincipal,
    permission: AdminPermission,
  ): void {
    if (
      !isAdminRequestPrincipal(actor) ||
      actor.role !== AdminRole.SUPER_ADMIN ||
      !hasAdminPermission(actor.role, permission) ||
      actor.permissionVersion < 1
    ) {
      throw new ForbiddenException('SPONSORED_SUPER_ADMIN_REQUIRED');
    }
  }

  private async assertLiveActor(
    actor: AdminRequestPrincipal,
    session: ClientSession,
  ): Promise<void> {
    // The principal was validated before this method. Match the persisted BSON
    // owner type explicitly; do not rely on implicit casting of session fields.
    const accountId = new Types.ObjectId(actor.adminAccountId);
    const account = await this.accounts
      .exists({
        _id: accountId,
        publicId: actor.publicId,
        role: AdminRole.SUPER_ADMIN,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        deletedAt: null,
        credentialVersion: actor.credentialVersion,
        authzVersion: actor.authzVersion,
        permissionVersion: actor.permissionVersion,
      })
      .session(session);
    const liveSession = await this.sessions
      .exists({
        adminAccountId: accountId,
        adminPublicId: actor.publicId,
        publicId: actor.sessionId,
        revokedAt: null,
        expiresAt: { $gt: this.now() },
      })
      .session(session);
    if (!account || !liveSession)
      throw new UnauthorizedException('SPONSORED_ADMIN_SESSION_INVALID');
  }

  private auditActor(
    actor: AdminRequestPrincipal,
    permission: AdminPermission,
  ): AdminAuditActorInput {
    return {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: actor.publicId,
      username: actor.username,
      displayName: actor.displayName,
      role: actor.role,
      permissionVersion: actor.permissionVersion,
      permission,
    };
  }

  private assertTarget(publicId: string, version: number): void {
    if (
      typeof publicId !== 'string' ||
      !SPONSORED_PUBLIC_ID_PATTERN.test(publicId) ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version >= 100000
    ) {
      throw new BadRequestException('SPONSORED_TARGET_INVALID');
    }
  }

  private assertContext(context: SponsoredMutationContext): void {
    if (
      !context ||
      typeof context.reasonCode !== 'string' ||
      !ADMIN_AUDIT_REASON_CODE_PATTERN.test(context.reasonCode) ||
      (context.correlationId !== undefined &&
        (typeof context.correlationId !== 'string' ||
          !ADMIN_AUDIT_CORRELATION_ID_PATTERN.test(context.correlationId)))
    ) {
      throw new BadRequestException('SPONSORED_AUDIT_CONTEXT_INVALID');
    }
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('SPONSORED_CLOCK_INVALID');
    }
    return new Date(now);
  }
}
