import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  ModerationReasonAction,
  ModerationReasonTarget,
} from '../../../common/moderation/moderation-reason.constants';
import {
  getCanonicalModerationReason,
  normalizeModerationReasonDetail,
} from '../../../common/moderation/moderation-reason.policy';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../auth/schemas/auth-session.schema';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import {
  USER_STATUS,
  User,
  type UserRestriction,
  type UserStatus,
} from '../../users/schemas/user.schema';
import {
  isActiveUserRestriction,
  toPublicUserRestriction,
} from '../../users/utils/user-restriction';
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
} from '../constants/admin-lifecycle.constants';
import {
  hasAdminPermission,
  type AdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
  ADMIN_USER_RESTRICTION_EVENT_TYPE,
  ADMIN_USER_RESTRICTION_IDEMPOTENCY_TTL_MS,
  ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH,
  ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH,
  AdminUserRestrictionOperation,
  getAdminUserRestrictionPermission,
} from '../constants/admin-user-restriction.constants';
import { isValidAdminUserPublicId } from '../constants/admin-user-query.constants';
import type {
  AdminUserRestrictionActor,
  AdminUserRestrictionMutationResult,
  UpdateAdminUserRestrictionInput,
} from '../interfaces/admin-user-restriction.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { AdminUserRestrictionRequest } from '../schemas/admin-user-restriction-request.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';

const IDEMPOTENCY_DOMAIN = 'betta:admin-user-restriction:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-user-restriction:fingerprint:v1';

type UserTarget = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  status: UserStatus;
  isDeleted: boolean;
  restriction: UserRestriction | null;
  version: number;
  authzVersion: number;
  updatedAt: Date;
}>;

type StoredRequest = Readonly<{
  requestFingerprint: string;
  targetPublicId: string;
  operation: AdminUserRestrictionOperation;
  restrictionType: UserRestrictionType;
  resultVersion: number;
  resultEffectiveAt: Date | null;
  resultExpiresAt: Date | null;
  resultSupportReference: string | null;
  resultPublicReasonCode: string | null;
  resultUpdatedAt: Date;
  revokedSessionCount: number;
}>;

type NormalizedInput = Omit<
  UpdateAdminUserRestrictionInput,
  | 'expiresAt'
  | 'publicReasonCode'
  | 'reasonCode'
  | 'reasonNote'
  | 'correlationId'
> &
  Readonly<{
    expiresAt?: Date;
    publicReasonCode?: string;
    reasonCode: string;
    reasonNote: string;
    correlationId?: string;
  }>;

const TARGET_PROJECTION =
  '_id publicId username fullname status isDeleted updatedAt ' +
  '+restriction +version +authzVersion';

@Injectable()
export class AdminUserRestrictionService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AdminAccount.name)
    private readonly adminAccounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessions: Model<AdminSession>,
    @InjectModel(AuthSession.name)
    private readonly targetSessions: Model<AuthSession>,
    @InjectModel(AdminUserRestrictionRequest.name)
    private readonly requests: Model<AdminUserRestrictionRequest>,
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
  ) {}

  async updateRestriction(
    input: UpdateAdminUserRestrictionInput,
  ): Promise<AdminUserRestrictionMutationResult> {
    const normalized = this.normalize(input);
    const replay = await this.loadReplay(normalized);
    if (replay) return replay;

    const now = new Date();
    this.assertTemporalValidity(normalized, now);
    const snapshot = await this.loadTarget(normalized.targetPublicId);
    if (!snapshot) throw new NotFoundException('Không tìm thấy User');
    this.assertTransition(snapshot, normalized);

    const nextRestriction = this.buildNextRestriction(normalized, now);

    try {
      return await this.connection.transaction(async (mongoSession) => {
        await this.assertActorStillEligible(normalized.actor, mongoSession);

        const update: Record<string, unknown> = {
          restriction: nextRestriction,
        };
        if (
          normalized.operation === AdminUserRestrictionOperation.REMOVE &&
          normalized.restrictionType === UserRestrictionType.INDEFINITE_BAN &&
          snapshot.status === USER_STATUS.BANNED
        ) {
          update.status = USER_STATUS.ACTIVE;
        }

        const updated = await this.users
          .findOneAndUpdate(
            {
              _id: snapshot._id,
              publicId: snapshot.publicId,
              isDeleted: false,
              version: normalized.expectedVersion,
            },
            {
              $set: update,
              $inc: { version: 1, authzVersion: 1 },
            },
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
          eventType: ADMIN_USER_RESTRICTION_EVENT_TYPE,
          dedupeKey: `user-restriction:${updated.publicId}:${updated.version}`,
          aggregateType: ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
          aggregatePublicId: updated.publicId,
          payload: {
            schemaVersion: 1,
            operation: normalized.operation,
            userPublicId: updated.publicId,
            restrictionType: normalized.restrictionType,
            restriction: updated.restriction
              ? {
                  ...toPublicUserRestriction(updated.restriction),
                  publicReasonCode: updated.restriction.publicReasonCode,
                }
              : null,
            beforeVersion: snapshot.version,
            afterVersion: updated.version,
          },
          correlationId: normalized.correlationId,
          mongoSession,
        });

        await this.audit.record({
          action: this.auditAction(normalized),
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
            beforeState: snapshot.restriction?.type ?? 'NONE',
            afterState: updated.restriction?.type ?? 'NONE',
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
              restrictionType: normalized.restrictionType,
              resultVersion: updated.version,
              resultEffectiveAt: updated.restriction?.effectiveAt ?? null,
              resultExpiresAt: updated.restriction?.expiresAt ?? null,
              resultSupportReference:
                updated.restriction?.supportReference ?? null,
              resultPublicReasonCode:
                updated.restriction?.publicReasonCode ?? null,
              resultUpdatedAt: updated.updatedAt,
              revokedSessionCount,
              idempotencyExpiresAt: new Date(
                now.getTime() + ADMIN_USER_RESTRICTION_IDEMPOTENCY_TTL_MS,
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

  private normalize(input: UpdateAdminUserRestrictionInput): NormalizedInput {
    const permission = getAdminUserRestrictionPermission(
      input.operation,
      input.restrictionType,
    );
    if (!permission) {
      throw new BadRequestException('Restriction operation không hợp lệ');
    }
    this.assertActor(input.actor, permission);

    const reasonCode = input.reasonCode?.trim();
    const reasonNote = normalizeModerationReasonDetail(
      input.reasonNote,
      ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH,
      ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH,
    );
    const publicReasonCode = input.publicReasonCode?.trim();
    const correlationId = input.correlationId?.trim();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    const reasonAction =
      input.operation === AdminUserRestrictionOperation.APPLY
        ? input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION
          ? ModerationReasonAction.APPLY_TEMPORARY_SUSPENSION
          : ModerationReasonAction.APPLY_INDEFINITE_BAN
        : input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION
          ? ModerationReasonAction.REMOVE_TEMPORARY_SUSPENSION
          : ModerationReasonAction.REMOVE_INDEFINITE_BAN;
    const canonicalReason = getCanonicalModerationReason(
      ModerationReasonTarget.USER_RESTRICTION,
      reasonAction,
      reasonCode,
    );
    const canonicalPublicReasonCode: string | null | undefined =
      canonicalReason?.publicReasonCode;

    if (
      !isValidAdminUserPublicId(input.targetPublicId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      !canonicalReason ||
      !reasonNote ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId))
    ) {
      throw new BadRequestException(
        'Admin User restriction input không hợp lệ',
      );
    }

    if (input.operation === AdminUserRestrictionOperation.APPLY) {
      if (!publicReasonCode || canonicalPublicReasonCode !== publicReasonCode) {
        throw new BadRequestException('Public restriction reason không hợp lệ');
      }
      if (input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION) {
        if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
          throw new BadRequestException(
            'Temporary suspension expiry không hợp lệ',
          );
        }
      } else if (input.expiresAt !== undefined) {
        throw new BadRequestException('Indefinite ban không được có expiresAt');
      }
    } else if (
      input.expiresAt !== undefined ||
      input.publicReasonCode !== undefined
    ) {
      throw new BadRequestException(
        'Remove restriction không nhận expiry hoặc public reason',
      );
    }

    return Object.freeze({
      ...input,
      expiresAt,
      publicReasonCode,
      reasonCode: canonicalReason.code,
      reasonNote,
      correlationId,
    });
  }

  private assertTemporalValidity(input: NormalizedInput, now: Date): void {
    if (
      input.operation === AdminUserRestrictionOperation.APPLY &&
      input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION &&
      (input.expiresAt as Date).getTime() <= now.getTime()
    ) {
      throw new BadRequestException('Temporary suspension expiry không hợp lệ');
    }
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

  private assertTransition(target: UserTarget, input: NormalizedInput): void {
    if (target.version !== input.expectedVersion) throw this.staleConflict();
    if (target.isDeleted) {
      throw new ConflictException('User đã xóa không thể thay đổi restriction');
    }

    if (input.operation === AdminUserRestrictionOperation.APPLY) {
      if (
        isActiveUserRestriction(target.restriction) ||
        target.status === USER_STATUS.BANNED
      ) {
        throw new ConflictException('User đang có restriction hiệu lực');
      }
      return;
    }

    if (
      !target.restriction ||
      target.restriction.type !== input.restrictionType
    ) {
      throw new ConflictException('User không có restriction phù hợp để gỡ');
    }
  }

  private buildNextRestriction(
    input: NormalizedInput,
    effectiveAt: Date,
  ): UserRestriction | null {
    if (input.operation === AdminUserRestrictionOperation.REMOVE) return null;
    return {
      type: input.restrictionType,
      effectiveAt,
      expiresAt:
        input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION
          ? (input.expiresAt as Date)
          : null,
      supportReference: `sup_${randomBytes(16).toString('base64url')}`,
      publicReasonCode: input.publicReasonCode as string,
    };
  }

  private async assertActorStillEligible(
    actor: AdminUserRestrictionActor,
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
          revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
        },
      },
      { session: mongoSession },
    );
    return result.modifiedCount;
  }

  private assertActor(
    actor: AdminUserRestrictionActor,
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
      throw new ForbiddenException('Admin không có quyền restriction phù hợp');
    }
  }

  private auditAction(input: NormalizedInput): AdminAuditAction {
    if (input.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION) {
      return input.operation === AdminUserRestrictionOperation.APPLY
        ? AdminAuditAction.USER_SUSPENDED
        : AdminAuditAction.USER_UNSUSPENDED;
    }
    return input.operation === AdminUserRestrictionOperation.APPLY
      ? AdminAuditAction.USER_BANNED
      : AdminAuditAction.USER_UNBANNED;
  }

  private async loadReplay(
    input: NormalizedInput,
  ): Promise<AdminUserRestrictionMutationResult | undefined> {
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

      const restriction = stored.resultSupportReference
        ? toPublicUserRestriction({
            type: stored.restrictionType,
            effectiveAt: stored.resultEffectiveAt as Date,
            expiresAt: stored.resultExpiresAt,
            supportReference: stored.resultSupportReference,
            publicReasonCode: stored.resultPublicReasonCode as string,
          })
        : null;
      return Object.freeze({
        user: Object.freeze({
          id: stored.targetPublicId,
          publicId: stored.targetPublicId,
          version: stored.resultVersion,
          restriction,
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
  ): AdminUserRestrictionMutationResult {
    return Object.freeze({
      user: Object.freeze({
        id: user.publicId,
        publicId: user.publicId,
        version: user.version,
        restriction: user.restriction
          ? toPublicUserRestriction(user.restriction)
          : null,
        updatedAt: user.updatedAt.toISOString(),
      }),
      revokedSessionCount,
    });
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
      input.restrictionType,
      String(input.expectedVersion),
      input.expiresAt?.toISOString() ?? '',
      input.publicReasonCode ?? '',
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
        'Dịch vụ restriction User tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
