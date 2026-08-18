import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
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
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../auth/schemas/auth-session.schema';
import { UserDeletionOrigin } from '../../users/constants/user-moderation.constants';
import {
  User,
  type UserRestriction,
  type UserStatus,
} from '../../users/schemas/user.schema';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
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
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
} from '../constants/admin-lifecycle.constants';
import {
  hasAdminPermission,
  type AdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_USER_DELETION_AGGREGATE_TYPE,
  ADMIN_USER_DELETION_EVENT_TYPE,
  ADMIN_USER_DELETION_IDEMPOTENCY_TTL_MS,
  ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH,
  ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH,
  AdminUserDeletionOperation,
  getAdminUserDeletionPermission,
} from '../constants/admin-user-deletion.constants';
import { isValidAdminUserPublicId } from '../constants/admin-user-query.constants';
import type {
  AdminUserDeletionActor,
  AdminUserDeletionMutationResult,
  PublicAdminUserDeletion,
  UpdateAdminUserDeletionInput,
} from '../interfaces/admin-user-deletion.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { AdminUserDeletionRequest } from '../schemas/admin-user-deletion-request.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';

const IDEMPOTENCY_DOMAIN = 'betta:admin-user-deletion:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-user-deletion:fingerprint:v1';

type UserTarget = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  status: UserStatus;
  isDeleted: boolean;
  deletedAt: Date | null;
  deletionOrigin: UserDeletionOrigin | null;
  restorableUntil: Date | null;
  restriction: UserRestriction | null;
  version: number;
  authzVersion: number;
  updatedAt: Date;
}>;

type StoredRequest = Readonly<{
  requestFingerprint: string;
  targetPublicId: string;
  operation: AdminUserDeletionOperation;
  resultVersion: number;
  resultIsDeleted: boolean;
  resultDeletionOrigin: UserDeletionOrigin | null;
  resultDeletedAt: Date | null;
  resultRestorableUntil: Date | null;
  resultUpdatedAt: Date;
  revokedSessionCount: number;
}>;

type NormalizedInput = Omit<
  UpdateAdminUserDeletionInput,
  'reasonCode' | 'reasonNote' | 'correlationId'
> &
  Readonly<{
    reasonCode: string;
    reasonNote: string;
    correlationId?: string;
  }>;

const TARGET_PROJECTION =
  '_id publicId username fullname status isDeleted deletedAt updatedAt ' +
  '+deletionOrigin +restorableUntil +restriction +version +authzVersion';

@Injectable()
export class AdminUserDeletionService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AdminAccount.name)
    private readonly adminAccounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessions: Model<AdminSession>,
    @InjectModel(AuthSession.name)
    private readonly targetSessions: Model<AuthSession>,
    @InjectModel(AdminUserDeletionRequest.name)
    private readonly requests: Model<AdminUserDeletionRequest>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
  ) {}

  async updateDeletion(
    input: UpdateAdminUserDeletionInput,
  ): Promise<AdminUserDeletionMutationResult> {
    const normalized = this.normalize(input);
    const replay = await this.loadReplay(normalized);
    if (replay) return replay;

    const snapshot = await this.loadTarget(normalized.targetPublicId);
    if (!snapshot) throw new NotFoundException('Không tìm thấy User');
    this.assertTransition(snapshot, normalized, new Date());

    try {
      return await this.connection.transaction(async (mongoSession) => {
        await this.assertActorStillEligible(normalized.actor, mongoSession);
        const transitionAt = new Date();
        this.assertTransition(snapshot, normalized, transitionAt);

        const updated = await this.users
          .findOneAndUpdate(
            this.casFilter(snapshot, normalized, transitionAt),
            this.transitionUpdate(normalized, transitionAt),
            {
              session: mongoSession,
              returnDocument: 'after',
              runValidators: true,
            },
          )
          .select(TARGET_PROJECTION)
          .lean<UserTarget | null>()
          .exec();
        if (!updated) throw this.staleConflict();

        const revokedSessionCount = await this.revokeTargetSessions(
          snapshot._id,
          mongoSession,
        );

        await this.outbox.enqueue({
          eventType: ADMIN_USER_DELETION_EVENT_TYPE,
          dedupeKey: `user-deletion:${updated.publicId}:${updated.version}`,
          aggregateType: ADMIN_USER_DELETION_AGGREGATE_TYPE,
          aggregatePublicId: updated.publicId,
          payload: {
            schemaVersion: 1,
            operation: normalized.operation,
            userPublicId: updated.publicId,
            deletion: this.toPublicDeletion(updated),
            beforeVersion: snapshot.version,
            afterVersion: updated.version,
          },
          correlationId: normalized.correlationId,
          mongoSession,
        });

        await this.audit.record({
          action:
            normalized.operation === AdminUserDeletionOperation.DELETE
              ? AdminAuditAction.USER_DELETED
              : AdminAuditAction.USER_RESTORED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: normalized.actor,
          target: {
            type: AdminAuditTargetType.USER,
            publicId: updated.publicId,
            displayName: updated.fullname,
          },
          reasonCode: normalized.reasonCode,
          reasonNote: normalized.reasonNote,
          metadata: {
            beforeVersion: snapshot.version,
            afterVersion: updated.version,
            beforeState: this.deletionState(snapshot),
            afterState: this.deletionState(updated),
            affectedSessionCount: revokedSessionCount,
          },
          correlationId: normalized.correlationId,
          source: AdminAuditSource.HTTP,
          mongoSession,
        });

        await this.requests.create(
          [
            {
              idempotencyHash: this.idempotencyHash(normalized),
              requestFingerprint: this.requestFingerprint(normalized),
              actorPublicId: normalized.actor.publicId,
              actorSessionPublicId: normalized.actor.sessionPublicId,
              targetUserId: snapshot._id,
              targetPublicId: updated.publicId,
              operation: normalized.operation,
              resultVersion: updated.version,
              resultIsDeleted: updated.isDeleted,
              resultDeletionOrigin: updated.deletionOrigin,
              resultDeletedAt: updated.deletedAt,
              resultRestorableUntil: updated.restorableUntil,
              resultUpdatedAt: updated.updatedAt,
              revokedSessionCount,
              idempotencyExpiresAt: new Date(
                transitionAt.getTime() + ADMIN_USER_DELETION_IDEMPOTENCY_TTL_MS,
              ),
            },
          ],
          { session: mongoSession },
        );

        return this.toResult(updated, revokedSessionCount);
      });
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) {
        const duplicateReplay = await this.loadReplay(normalized);
        if (duplicateReplay) return duplicateReplay;
      }
      this.rethrow(error);
    }
  }

  private normalize(input: UpdateAdminUserDeletionInput): NormalizedInput {
    const permission = getAdminUserDeletionPermission(input.operation);
    if (!permission) {
      throw new BadRequestException('Deletion operation không hợp lệ');
    }
    this.assertActor(input.actor, permission);

    const reasonCode = input.reasonCode?.trim();
    const reasonNote = input.reasonNote?.trim();
    const correlationId = input.correlationId?.trim();
    if (
      !isValidAdminUserPublicId(input.targetPublicId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      !ADMIN_LIFECYCLE_REASON_CODE_PATTERN.test(reasonCode) ||
      reasonNote.length < ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH ||
      reasonNote.length > ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId))
    ) {
      throw new BadRequestException('Admin User deletion input không hợp lệ');
    }

    return Object.freeze({
      ...input,
      reasonCode,
      reasonNote,
      correlationId,
    });
  }

  private async loadTarget(publicId: string): Promise<UserTarget | null> {
    try {
      return await this.users
        .findOne({ publicId })
        .select(TARGET_PROJECTION)
        .lean<UserTarget | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private assertTransition(
    target: UserTarget,
    input: NormalizedInput,
    now: Date,
  ): void {
    if (target.version !== input.expectedVersion) throw this.staleConflict();

    if (input.operation === AdminUserDeletionOperation.DELETE) {
      if (target.isDeleted) {
        throw new ConflictException('User đã ở trạng thái xóa');
      }
      return;
    }

    if (
      !target.isDeleted ||
      target.deletionOrigin !== UserDeletionOrigin.ADMIN_MODERATION
    ) {
      throw new ConflictException(
        'Chỉ User do Admin xóa mềm mới được khôi phục',
      );
    }
    if (
      !target.deletedAt ||
      !target.restorableUntil ||
      target.restorableUntil.getTime() <= now.getTime()
    ) {
      throw new ConflictException('Thời hạn khôi phục User đã kết thúc');
    }
  }

  private casFilter(
    snapshot: UserTarget,
    input: NormalizedInput,
    now: Date,
  ): Record<string, unknown> {
    const common = {
      _id: snapshot._id,
      publicId: snapshot.publicId,
      version: input.expectedVersion,
    };
    if (input.operation === AdminUserDeletionOperation.DELETE) {
      return { ...common, isDeleted: false };
    }
    return {
      ...common,
      isDeleted: true,
      deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
      deletedAt: { $type: 'date' },
      restorableUntil: { $gt: now },
    };
  }

  private transitionUpdate(
    input: NormalizedInput,
    now: Date,
  ): Record<string, unknown> {
    if (input.operation === AdminUserDeletionOperation.DELETE) {
      return {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
          restorableUntil: new Date(
            now.getTime() +
              this.policy.retention.adminUserRestoreDays * 86_400_000,
          ),
        },
        $inc: { version: 1, authzVersion: 1 },
      };
    }
    return {
      $set: {
        isDeleted: false,
        deletionOrigin: null,
        restorableUntil: null,
      },
      $unset: { deletedAt: 1 },
      $inc: { version: 1, authzVersion: 1 },
    };
  }

  private async assertActorStillEligible(
    actor: AdminUserDeletionActor,
    mongoSession: ClientSession,
  ): Promise<void> {
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
          expiresAt: { $gt: new Date() },
        })
        .session(mongoSession),
    ]);
    if (!accountExists || !sessionExists) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
  }

  private async revokeTargetSessions(
    targetUserId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<number> {
    const result = await this.targetSessions.updateMany(
      { userId: targetUserId, revokedAt: null },
      {
        $set: {
          revokedAt: new Date(),
          revokeReason: SessionRevokeReason.ACCOUNT_DELETED,
        },
      },
      { session: mongoSession },
    );
    return result.modifiedCount;
  }

  private assertActor(
    actor: AdminUserDeletionActor,
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
      throw new ForbiddenException('Admin không có quyền xóa User phù hợp');
    }
  }

  private async loadReplay(
    input: NormalizedInput,
  ): Promise<AdminUserDeletionMutationResult | undefined> {
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
      return Object.freeze({
        user: Object.freeze({
          id: stored.targetPublicId,
          publicId: stored.targetPublicId,
          version: stored.resultVersion,
          deletion: Object.freeze({
            isDeleted: stored.resultIsDeleted,
            origin: stored.resultDeletionOrigin,
            deletedAt: stored.resultDeletedAt?.toISOString() ?? null,
            restorableUntil:
              stored.resultRestorableUntil?.toISOString() ?? null,
          }),
          updatedAt: stored.resultUpdatedAt.toISOString(),
        }),
        revokedSessionCount: stored.revokedSessionCount,
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private toResult(
    user: UserTarget,
    revokedSessionCount: number,
  ): AdminUserDeletionMutationResult {
    return Object.freeze({
      user: Object.freeze({
        id: user.publicId,
        publicId: user.publicId,
        version: user.version,
        deletion: this.toPublicDeletion(user),
        updatedAt: user.updatedAt.toISOString(),
      }),
      revokedSessionCount,
    });
  }

  private toPublicDeletion(user: UserTarget): PublicAdminUserDeletion {
    return Object.freeze({
      isDeleted: user.isDeleted,
      origin: user.deletionOrigin ?? null,
      deletedAt: user.deletedAt?.toISOString() ?? null,
      restorableUntil: user.restorableUntil?.toISOString() ?? null,
    });
  }

  private deletionState(user: UserTarget): string {
    return user.isDeleted
      ? (user.deletionOrigin ?? 'DELETED_UNKNOWN_ORIGIN')
      : 'ACTIVE';
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
      input.targetPublicId,
      input.operation,
      String(input.expectedVersion),
      input.reasonCode,
      input.reasonNote,
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

  private staleConflict(): ConflictException {
    return new ConflictException('User đã được cập nhật bởi yêu cầu khác');
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ xóa User tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
