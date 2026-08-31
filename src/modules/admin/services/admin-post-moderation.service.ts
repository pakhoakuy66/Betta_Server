import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_AUTHENTICATION_FAILED_MESSAGE,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN } from '../constants/admin-lifecycle.constants';
import {
  hasAdminPermission,
  type AdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_MS,
  ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN,
  ADMIN_POST_MODERATION_FAILURE_INJECTOR,
  ADMIN_POST_MODERATION_REPLAY_WAIT_DELAYS_MS,
  ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH,
  ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH,
  AdminPostModerationOperation,
  AdminPostModerationFailureStep,
  AdminPostModerationRequestState,
  getAdminPostModerationPermission,
} from '../constants/admin-post-moderation.constants';
import type {
  AdminPostModerationActor,
  AdminPostModerationFailureInjector,
  AdminPostModerationMutationResult,
  UpdateAdminPostModerationInput,
} from '../interfaces/admin-post-moderation.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminPostModerationRequest } from '../schemas/admin-post-moderation-request.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminPostLifecycleService } from './admin-post-lifecycle.service';

const IDEMPOTENCY_DOMAIN = 'betta:admin-post-moderation:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-post-moderation:fingerprint:v1';

type StoredRequest = Readonly<{
  requestFingerprint: string;
  postPublicId: string;
  state: AdminPostModerationRequestState;
  resultState: AdminPostModerationMutationResult['post']['state'] | null;
  resultModerationVersion: number | null;
  resultModeratedAt: Date | null;
  resultCleanupRequested: boolean | null;
}>;

type CompletedStoredRequest = StoredRequest &
  Readonly<{
    state: AdminPostModerationRequestState.COMPLETED;
    resultState: AdminPostModerationMutationResult['post']['state'];
    resultModerationVersion: number;
    resultModeratedAt: Date;
    resultCleanupRequested: boolean;
  }>;

type NormalizedInput = Omit<
  UpdateAdminPostModerationInput,
  'reasonCode' | 'reasonNote' | 'correlationId'
> &
  Readonly<{
    reasonCode: string;
    reasonNote?: string;
    correlationId?: string;
  }>;

@Injectable()
export class AdminPostModerationService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly adminAccounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessions: Model<AdminSession>,
    @InjectModel(AdminPostModerationRequest.name)
    private readonly requests: Model<AdminPostModerationRequest>,
    @InjectConnection() private readonly connection: Connection,
    private readonly lifecycle: AdminPostLifecycleService,
    private readonly audit: AdminAuditService,
    @Optional()
    @Inject(ADMIN_POST_MODERATION_FAILURE_INJECTOR)
    private readonly failureInjector?: AdminPostModerationFailureInjector,
  ) {}

  async update(
    input: UpdateAdminPostModerationInput,
  ): Promise<AdminPostModerationMutationResult> {
    const normalized = this.normalize(input);
    const replay = await this.loadReplay(normalized);
    if (replay) return replay;

    try {
      return await this.connection.transaction(async (mongoSession) => {
        await this.assertActorStillEligible(normalized.actor, mongoSession);
        const now = new Date();
        await this.reserveRequest(normalized, now, mongoSession);
        await this.hit(AdminPostModerationFailureStep.AFTER_RESERVATION);
        const transition = await this.lifecycle.transition(
          {
            actorPublicId: normalized.actor.publicId,
            postPublicId: normalized.postPublicId,
            operation: normalized.operation,
            expectedModerationVersion: normalized.expectedModerationVersion,
            reasonCode: normalized.reasonCode as never,
            reasonNote: normalized.reasonNote,
            correlationId: normalized.correlationId,
          },
          mongoSession,
        );
        await this.hit(AdminPostModerationFailureStep.AFTER_TARGET);

        await this.lifecycle.enqueue({
          transition,
          operation: normalized.operation,
          correlationId: normalized.correlationId,
          mongoSession,
        });
        await this.hit(AdminPostModerationFailureStep.AFTER_OUTBOX);
        await this.audit.record({
          action: this.auditAction(normalized.operation),
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: normalized.actor,
          target: {
            type: AdminAuditTargetType.POST,
            publicId: transition.postPublicId,
          },
          reasonCode: normalized.reasonCode,
          reasonNote: normalized.reasonNote,
          metadata: {
            beforeVersion: transition.beforeVersion,
            afterVersion: transition.afterVersion,
            beforeState: transition.beforeState,
            afterState: transition.afterState,
          },
          correlationId: normalized.correlationId,
          source: AdminAuditSource.HTTP,
          mongoSession,
        });
        await this.hit(AdminPostModerationFailureStep.AFTER_AUDIT);

        const cleanupRequested =
          normalized.operation === AdminPostModerationOperation.TERMINAL_DELETE;
        await this.completeRequest(
          normalized,
          {
            state: transition.afterState,
            moderationVersion: transition.afterVersion,
            moderatedAt: transition.moderatedAt,
            cleanupRequested,
          },
          mongoSession,
        );
        await this.hit(AdminPostModerationFailureStep.AFTER_REQUEST);
        return this.result(
          transition.postPublicId,
          transition.afterState,
          transition.afterVersion,
          transition.moderatedAt,
          cleanupRequested,
        );
      });
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) {
        const duplicateReplay =
          await this.loadReplayAfterConcurrentCommit(normalized);
        if (duplicateReplay) return duplicateReplay;
      }
      this.rethrow(error);
    }
  }

  private async reserveRequest(
    input: NormalizedInput,
    now: Date,
    mongoSession: ClientSession,
  ): Promise<void> {
    await this.requests.insertMany(
      [
        {
          idempotencyHash: this.idempotencyHash(input),
          requestFingerprint: this.requestFingerprint(input),
          actorPublicId: input.actor.publicId,
          actorSessionPublicId: input.actor.sessionPublicId,
          postPublicId: input.postPublicId,
          operation: input.operation,
          state: AdminPostModerationRequestState.PENDING,
          idempotencyExpiresAt: new Date(
            now.getTime() + ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_MS,
          ),
        },
      ],
      { session: mongoSession },
    );
  }

  private async completeRequest(
    input: NormalizedInput,
    result: Readonly<{
      state: AdminPostModerationMutationResult['post']['state'];
      moderationVersion: number;
      moderatedAt: Date;
      cleanupRequested: boolean;
    }>,
    mongoSession: ClientSession,
  ): Promise<void> {
    const completion = await this.requests.updateOne(
      {
        idempotencyHash: this.idempotencyHash(input),
        requestFingerprint: this.requestFingerprint(input),
        state: AdminPostModerationRequestState.PENDING,
      },
      {
        $set: {
          state: AdminPostModerationRequestState.COMPLETED,
          resultState: result.state,
          resultModerationVersion: result.moderationVersion,
          resultModeratedAt: result.moderatedAt,
          resultCleanupRequested: result.cleanupRequested,
        },
      },
      { session: mongoSession, runValidators: true },
    );
    if (completion.matchedCount !== 1 || completion.modifiedCount !== 1) {
      throw new Error('POST_MODERATION_IDEMPOTENCY_COMPLETION_FAILED');
    }
  }

  private normalize(input: UpdateAdminPostModerationInput): NormalizedInput {
    const permission = getAdminPostModerationPermission(input.operation);
    this.assertActor(input.actor, permission);
    const reasonCode = input.reasonCode?.trim();
    const reasonNote = input.reasonNote?.trim();
    const correlationId = input.correlationId?.trim();
    if (
      !isValidPostPublicId(input.postPublicId) ||
      !Number.isSafeInteger(input.expectedModerationVersion) ||
      input.expectedModerationVersion < 0 ||
      !ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN.test(
        input.idempotencyKey,
      ) ||
      !reasonCode ||
      (reasonNote !== undefined &&
        (reasonNote.length < ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH ||
          reasonNote.length > ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH)) ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId))
    ) {
      throw new BadRequestException('Admin Post moderation input không hợp lệ');
    }
    return Object.freeze({
      ...input,
      reasonCode,
      reasonNote,
      correlationId,
    });
  }

  private assertActor(
    actor: AdminPostModerationActor,
    permission: AdminPermission,
  ): void {
    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      (actor.role !== AdminRole.ADMIN &&
        actor.role !== AdminRole.SUPER_ADMIN) ||
      actor.permission !== permission ||
      !hasAdminPermission(actor.role, permission) ||
      !(actor.adminAccountId instanceof Types.ObjectId) ||
      !isValidAdminPublicId(actor.publicId) ||
      !actor.username ||
      !actor.displayName ||
      !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(actor.sessionPublicId) ||
      !Number.isSafeInteger(actor.credentialVersion) ||
      actor.credentialVersion < 0 ||
      !Number.isSafeInteger(actor.authzVersion) ||
      actor.authzVersion < 0 ||
      !Number.isSafeInteger(actor.permissionVersion) ||
      actor.permissionVersion < 1
    ) {
      throw new ForbiddenException('Admin không có quyền moderation Post');
    }
  }

  private async assertActorStillEligible(
    actor: AdminPostModerationActor,
    mongoSession: ClientSession,
  ): Promise<void> {
    const now = new Date();
    const [accountExists, sessionExists] = await Promise.all([
      this.adminAccounts
        .exists({
          _id: actor.adminAccountId,
          publicId: actor.publicId,
          role: actor.role,
          status: AdminAccountStatus.ACTIVE,
          mfaStatus: AdminMfaStatus.ACTIVE,
          mustChangePassword: false,
          credentialVersion: actor.credentialVersion,
          authzVersion: actor.authzVersion,
          permissionVersion: actor.permissionVersion,
          deletedAt: null,
        })
        .session(mongoSession),
      this.adminSessions
        .exists({
          adminAccountId: actor.adminAccountId,
          adminPublicId: actor.publicId,
          publicId: actor.sessionPublicId,
          revokedAt: null,
          expiresAt: { $gt: now },
        })
        .session(mongoSession),
    ]);
    if (!accountExists || !sessionExists) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
  }

  private async loadReplay(
    input: NormalizedInput,
  ): Promise<AdminPostModerationMutationResult | undefined> {
    try {
      const stored = await this.requests
        .findOne({ idempotencyHash: this.idempotencyHash(input) })
        .select('+requestFingerprint')
        .lean<StoredRequest | null>()
        .exec();
      if (!stored) return undefined;
      if (stored.requestFingerprint !== this.requestFingerprint(input)) {
        throw new ConflictException(
          'Idempotency-Key đã được dùng cho payload khác',
        );
      }
      if (
        stored.state !== AdminPostModerationRequestState.COMPLETED ||
        stored.resultState === null ||
        stored.resultModerationVersion === null ||
        stored.resultModeratedAt === null ||
        stored.resultCleanupRequested === null
      ) {
        return undefined;
      }
      return this.storedResult(stored as CompletedStoredRequest);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async loadReplayAfterConcurrentCommit(
    input: NormalizedInput,
  ): Promise<AdminPostModerationMutationResult | undefined> {
    const immediate = await this.loadReplay(input);
    if (immediate) return immediate;
    for (const delayMs of ADMIN_POST_MODERATION_REPLAY_WAIT_DELAYS_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const replay = await this.loadReplay(input);
      if (replay) return replay;
    }
    return undefined;
  }

  private storedResult(
    stored: CompletedStoredRequest,
  ): AdminPostModerationMutationResult {
    return this.result(
      stored.postPublicId,
      stored.resultState,
      stored.resultModerationVersion,
      stored.resultModeratedAt,
      stored.resultCleanupRequested,
    );
  }

  private result(
    publicId: string,
    state: AdminPostModerationMutationResult['post']['state'],
    moderationVersion: number,
    moderatedAt: Date,
    cleanupRequested: boolean,
  ): AdminPostModerationMutationResult {
    return Object.freeze({
      post: Object.freeze({
        id: publicId,
        publicId,
        state,
        moderationVersion,
        moderatedAt: moderatedAt.toISOString(),
        cleanupRequested,
      }),
    });
  }

  private auditAction(
    operation: AdminPostModerationOperation,
  ): AdminAuditAction {
    if (operation === AdminPostModerationOperation.HIDE) {
      return AdminAuditAction.POST_HIDDEN;
    }
    if (operation === AdminPostModerationOperation.RESTORE) {
      return AdminAuditAction.POST_RESTORED;
    }
    return AdminAuditAction.POST_DELETED;
  }

  private idempotencyHash(input: NormalizedInput): string {
    return this.hash([
      IDEMPOTENCY_DOMAIN,
      input.actor.publicId,
      input.idempotencyKey,
    ]);
  }

  private requestFingerprint(input: NormalizedInput): string {
    return this.hash([
      FINGERPRINT_DOMAIN,
      input.postPublicId,
      input.operation,
      String(input.expectedModerationVersion),
      input.reasonCode,
      input.reasonNote ?? '',
      input.correlationId ?? '',
    ]);
  }

  private hash(parts: readonly string[]): string {
    return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      Number(error.code) === 11000
    );
  }

  private async hit(step: AdminPostModerationFailureStep): Promise<void> {
    await this.failureInjector?.hit(step);
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ moderation Post tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
