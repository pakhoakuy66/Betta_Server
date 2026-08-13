import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCOUNT_STATUS_REASON_NOTE_MAX_LENGTH,
  ADMIN_ACCOUNT_STATUS_REASON_NOTE_MIN_LENGTH,
  getAdminAccountStatusPermission,
} from '../constants/admin-account-status.constants';
import { ADMIN_SECURITY_GRANT_PATTERN } from '../constants/admin-account-recovery.constants';
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
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
} from '../constants/admin-lifecycle.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import {
  type AdminAccountStatusActor,
  type AdminAccountStatusMutationResult,
  type IssueSuperAdminStatusReauthInput,
  type UpdateAdminAccountStatusInput,
} from '../interfaces/admin-account-status.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminLastSuperAdminInvariantService } from './admin-last-super-admin-invariant.service';
import { AdminReauthService } from './admin-reauth.service';
import { AdminSessionService } from './admin-session.service';

type StatusTarget = Pick<
  AdminAccount,
  | 'publicId'
  | 'displayName'
  | 'role'
  | 'status'
  | 'version'
  | 'authzVersion'
  | 'lockedAt'
  | 'deletedAt'
  | 'updatedAt'
> & { _id: Types.ObjectId };

type NormalizedStatusInput = Omit<
  UpdateAdminAccountStatusInput,
  'reasonCode' | 'reasonNote' | 'correlationId'
> &
  Readonly<{
    reasonCode: string;
    reasonNote: string;
    correlationId?: string;
  }>;

const TARGET_PROJECTION =
  '_id publicId displayName role status lockedAt deletedAt updatedAt ' +
  '+version +authzVersion';

@Injectable()
export class AdminAccountStatusService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly sessions: Model<AdminSession>,
    @InjectConnection() private readonly connection: Connection,
    private readonly lastSuperAdmin: AdminLastSuperAdminInvariantService,
    private readonly reauth: AdminReauthService,
    private readonly sessionService: AdminSessionService,
    private readonly audit: AdminAuditService,
  ) {}

  async issueSuperAdminStatusReauth(input: IssueSuperAdminStatusReauthInput) {
    const permission = getAdminAccountStatusPermission(input.status);
    if (!permission) {
      throw new TypeError('SuperAdmin status re-auth input không hợp lệ');
    }
    this.assertActor(input.actor, permission);
    if (
      !isValidAdminPublicId(input.targetPublicId) ||
      input.targetPublicId === input.actor.publicId ||
      typeof input.password !== 'string' ||
      input.password.length < 1 ||
      input.password.length > 64 ||
      typeof input.totpToken !== 'string' ||
      !/^\d{6}$/u.test(input.totpToken) ||
      typeof input.trustedClientIp !== 'string' ||
      input.trustedClientIp.length < 1
    ) {
      throw new TypeError('Admin status re-auth input không hợp lệ');
    }

    const target = await this.loadTarget(input.targetPublicId);
    if (!target) {
      throw new NotFoundException('Không tìm thấy tài khoản quản trị');
    }
    if (
      target.role !== AdminRole.SUPER_ADMIN ||
      target.status === input.status ||
      !(
        (target.status === AdminAccountStatus.ACTIVE &&
          input.status === AdminAccountStatus.LOCKED) ||
        (target.status === AdminAccountStatus.LOCKED &&
          input.status === AdminAccountStatus.ACTIVE)
      ) ||
      target.deletedAt != null
    ) {
      throw new ConflictException(
        'Re-auth này chỉ áp dụng cho chuyển trạng thái SuperAdmin hợp lệ',
      );
    }

    return this.reauth.issue({
      adminAccountId: input.actor.adminAccountId,
      adminPublicId: input.actor.publicId,
      sessionPublicId: input.actor.sessionPublicId,
      password: input.password,
      totpToken: input.totpToken,
      purpose: this.reauthPurpose(input.status),
      targetPublicId: target.publicId,
      trustedClientIp: input.trustedClientIp,
      actor: input.actor,
      source: AdminAuditSource.HTTP,
    });
  }

  async updateStatus(
    input: UpdateAdminAccountStatusInput,
  ): Promise<AdminAccountStatusMutationResult> {
    const normalized = this.normalizeStatusInput(input);
    if (normalized.targetPublicId === normalized.actor.publicId) {
      throw new ForbiddenException(
        'Không được tự thay đổi trạng thái khóa của tài khoản đang thao tác',
      );
    }

    const snapshot = await this.loadTarget(normalized.targetPublicId);
    if (!snapshot) {
      throw new NotFoundException('Không tìm thấy tài khoản quản trị');
    }
    this.assertTransition(snapshot, normalized);

    const changesSuperAdmin = snapshot.role === AdminRole.SUPER_ADMIN;
    const locksSuperAdmin =
      changesSuperAdmin && normalized.status === AdminAccountStatus.LOCKED;
    if (changesSuperAdmin && !normalized.reauthGrant) {
      throw this.invalidReauth();
    }
    if (!changesSuperAdmin && normalized.reauthGrant !== undefined) {
      throw new TypeError(
        'Re-auth grant chỉ được dùng khi thay đổi trạng thái SuperAdmin',
      );
    }
    if (locksSuperAdmin) await this.lastSuperAdmin.prepareCoordinator();

    try {
      return await this.connection.transaction(async (mongoSession) => {
        if (locksSuperAdmin) {
          await this.lastSuperAdmin.assertCanRemoveEffectiveAccess(
            snapshot._id,
            mongoSession,
          );
        }
        await this.assertActorStillEligible(normalized.actor, mongoSession);

        if (changesSuperAdmin) {
          await this.reauth.consumeInTransaction({
            rawGrant: normalized.reauthGrant as string,
            adminAccountId: normalized.actor.adminAccountId,
            adminPublicId: normalized.actor.publicId,
            sessionPublicId: normalized.actor.sessionPublicId,
            credentialVersion: normalized.actor.credentialVersion,
            authzVersion: normalized.actor.authzVersion,
            permissionVersion: normalized.actor.permissionVersion,
            purpose: this.reauthPurpose(normalized.status),
            targetPublicId: snapshot.publicId,
            actor: normalized.actor,
            source: AdminAuditSource.HTTP,
            mongoSession,
          });
        }

        const now = new Date();
        const updated = await this.accounts
          .findOneAndUpdate(
            {
              _id: snapshot._id,
              publicId: snapshot.publicId,
              role: snapshot.role,
              status: snapshot.status,
              version: normalized.expectedVersion,
              deletedAt: null,
            },
            {
              $set: {
                status: normalized.status,
                lockedAt:
                  normalized.status === AdminAccountStatus.LOCKED ? now : null,
              },
              $inc: { authzVersion: 1, version: 1 },
            },
            {
              returnDocument: 'after',
              runValidators: true,
              session: mongoSession,
            },
          )
          .select(TARGET_PROJECTION)
          .lean<StatusTarget | null>()
          .exec();
        if (!updated) throw this.staleConflict();

        const revokedSessionCount =
          normalized.status === AdminAccountStatus.LOCKED
            ? await this.sessionService.revokeAllInTransaction({
                targetAdminAccountId: snapshot._id,
                targetAdminPublicId: snapshot.publicId,
                reason: AdminSessionRevokeReason.ACCOUNT_LOCKED,
                auditActor: normalized.actor,
                auditSource: AdminAuditSource.HTTP,
                mongoSession,
              })
            : 0;

        await this.audit.record({
          action:
            normalized.status === AdminAccountStatus.LOCKED
              ? AdminAuditAction.ADMIN_LOCKED
              : AdminAuditAction.ADMIN_UNLOCKED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: normalized.actor,
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: updated.publicId,
            displayName: updated.displayName,
          },
          reasonCode: normalized.reasonCode,
          reasonNote: normalized.reasonNote,
          metadata: {
            beforeVersion: snapshot.version,
            afterVersion: updated.version,
            beforeState: snapshot.status,
            afterState: updated.status,
            affectedSessionCount: revokedSessionCount,
          },
          correlationId: normalized.correlationId,
          source: AdminAuditSource.HTTP,
          mongoSession,
        });

        return this.toResult(updated, revokedSessionCount);
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private normalizeStatusInput(
    input: UpdateAdminAccountStatusInput,
  ): NormalizedStatusInput {
    const permission = getAdminAccountStatusPermission(input.status);
    if (!permission) {
      throw new TypeError('AdminAccount status yêu cầu không hợp lệ');
    }
    this.assertActor(input.actor, permission);

    const reasonCode =
      typeof input.reasonCode === 'string' ? input.reasonCode.trim() : '';
    const reasonNote =
      typeof input.reasonNote === 'string' ? input.reasonNote.trim() : '';
    const correlationId = input.correlationId?.trim();
    if (
      !isValidAdminPublicId(input.targetPublicId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !ADMIN_LIFECYCLE_REASON_CODE_PATTERN.test(reasonCode) ||
      reasonNote.length < ADMIN_ACCOUNT_STATUS_REASON_NOTE_MIN_LENGTH ||
      reasonNote.length > ADMIN_ACCOUNT_STATUS_REASON_NOTE_MAX_LENGTH ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId)) ||
      (input.reauthGrant !== undefined &&
        !ADMIN_SECURITY_GRANT_PATTERN.test(input.reauthGrant))
    ) {
      throw new TypeError('AdminAccount status input không hợp lệ');
    }

    return Object.freeze({
      ...input,
      reasonCode,
      reasonNote,
      correlationId,
    });
  }

  private assertTransition(
    snapshot: StatusTarget,
    input: NormalizedStatusInput,
  ): void {
    if (snapshot.version !== input.expectedVersion) {
      throw this.staleConflict();
    }
    const expectedCurrentStatus =
      input.status === AdminAccountStatus.LOCKED
        ? AdminAccountStatus.ACTIVE
        : AdminAccountStatus.LOCKED;
    if (
      snapshot.status !== expectedCurrentStatus ||
      snapshot.deletedAt != null
    ) {
      throw new ConflictException(
        'Trạng thái tài khoản quản trị không cho phép thao tác này',
      );
    }
  }

  private async loadTarget(publicId: string): Promise<StatusTarget | null> {
    try {
      return await this.accounts
        .findOne({ publicId })
        .select(TARGET_PROJECTION)
        .lean<StatusTarget | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async assertActorStillEligible(
    actor: AdminAccountStatusActor,
    mongoSession: ClientSession,
  ): Promise<void> {
    const [accountExists, sessionExists] = await Promise.all([
      this.accounts
        .exists({
          _id: actor.adminAccountId,
          publicId: actor.publicId,
          role: AdminRole.SUPER_ADMIN,
          status: AdminAccountStatus.ACTIVE,
          mfaStatus: AdminMfaStatus.ACTIVE,
          mustChangePassword: false,
          credentialVersion: actor.credentialVersion,
          authzVersion: actor.authzVersion,
          permissionVersion: actor.permissionVersion,
          deletedAt: null,
        })
        .session(mongoSession),
      this.sessions
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

  private assertActor(
    actor: AdminAccountStatusActor,
    requiredPermission: AdminPermission,
  ): void {
    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      actor.role !== AdminRole.SUPER_ADMIN ||
      actor.permission !== requiredPermission ||
      !(actor.adminAccountId instanceof Types.ObjectId) ||
      !isValidAdminPublicId(actor.publicId) ||
      typeof actor.username !== 'string' ||
      actor.username.length < 1 ||
      typeof actor.displayName !== 'string' ||
      actor.displayName.length < 1 ||
      !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(actor.sessionPublicId) ||
      !Number.isSafeInteger(actor.credentialVersion) ||
      actor.credentialVersion < 0 ||
      !Number.isSafeInteger(actor.authzVersion) ||
      actor.authzVersion < 0 ||
      !Number.isSafeInteger(actor.permissionVersion) ||
      actor.permissionVersion < 1
    ) {
      throw new ForbiddenException(
        'Chỉ SuperAdmin có quyền phù hợp mới được thay đổi trạng thái Admin',
      );
    }
  }

  private toResult(
    updated: StatusTarget,
    revokedSessionCount: number,
  ): AdminAccountStatusMutationResult {
    return Object.freeze({
      admin: Object.freeze({
        id: updated.publicId,
        publicId: updated.publicId,
        status: updated.status,
        version: updated.version,
        lockedAt:
          updated.lockedAt instanceof Date
            ? updated.lockedAt.toISOString()
            : null,
        updatedAt: updated.updatedAt.toISOString(),
      }),
      revokedSessionCount,
    });
  }

  private reauthPurpose(status: AdminAccountStatus): AdminReauthPurpose {
    return status === AdminAccountStatus.LOCKED
      ? AdminReauthPurpose.SUPER_ADMIN_LOCK
      : AdminReauthPurpose.SUPER_ADMIN_UNLOCK;
  }

  private staleConflict(): ConflictException {
    return new ConflictException(
      'Tài khoản quản trị đã được cập nhật bởi yêu cầu khác',
    );
  }

  private invalidReauth(): UnauthorizedException {
    return new UnauthorizedException(
      'Xác thực lại không hợp lệ hoặc đã hết hạn',
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ lifecycle Admin tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
