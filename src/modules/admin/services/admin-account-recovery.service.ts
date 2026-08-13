import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { type Connection, type Model, Types } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  ADMIN_PASSWORD_COMPLEXITY_PATTERN,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MAX_UTF8_BYTES,
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_RECOVERY_GRANT_TTL_SECONDS,
  AdminRecoveryPurpose,
} from '../constants/admin-account-recovery.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import {
  ADMIN_RECOVERY_SECRET_STORE,
  type AdminRecoveryEnrollmentChallenge,
  type AdminRecoveryGrantResult,
  type AdminRecoverySecretStore,
  type BeginRecoveryGrantEnrollmentInput,
  type BreakGlassRecoveryInput,
  type ConfirmRecoveryEnrollmentInput,
  type ResetAdminMfaInput,
} from '../interfaces/admin-account-recovery.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminRecoveryGrant } from '../schemas/admin-recovery-grant.schema';
import {
  encodeAdminTotpSecret,
  findMatchingAdminTotpStep,
} from '../utils/admin-totp';
import {
  generateAdminSecurityGrant,
  hashAdminRecoveryGrant,
} from '../utils/admin-security-grant';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';
import { AdminLoginProtectionService } from './admin-login-protection.service';
import { AdminReauthService } from './admin-reauth.service';
import { AdminSessionService } from './admin-session.service';

const OPERATOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{2,119}$/;
const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{7,119}$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,63}$/;

type RecoveryAccount = Pick<
  AdminAccount,
  | 'publicId'
  | 'username'
  | 'displayName'
  | 'role'
  | 'status'
  | 'mfaStatus'
  | 'credentialVersion'
  | 'authzVersion'
  | 'permissionVersion'
  | 'version'
  | 'activationGrantConsumedAt'
> & { _id: Types.ObjectId };

@Injectable()
export class AdminAccountRecoveryService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminRecoveryGrant.name)
    private readonly grants: Model<AdminRecoveryGrant>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    @Inject(ADMIN_RECOVERY_SECRET_STORE)
    private readonly secretStore: AdminRecoverySecretStore,
    private readonly crypto: AdminMfaCryptoService,
    private readonly loginProtection: AdminLoginProtectionService,
    private readonly reauth: AdminReauthService,
    private readonly sessions: AdminSessionService,
    private readonly audit: AdminAuditService,
  ) {}

  async resetAdminMfa(
    input: ResetAdminMfaInput,
  ): Promise<AdminRecoveryGrantResult> {
    if (
      input.actor.role !== AdminRole.SUPER_ADMIN ||
      !Types.ObjectId.isValid(input.actorAdminAccountId) ||
      input.actor.publicId === input.targetAdminPublicId ||
      !isValidAdminPublicId(input.targetAdminPublicId)
    ) {
      throw new UnauthorizedException('Không được phép reset MFA Admin');
    }
    const actor = await this.loadAccount(
      input.actorAdminAccountId,
      input.actor.publicId,
    );
    const target = await this.loadByPublicId(input.targetAdminPublicId);
    if (
      !actor ||
      actor.role !== AdminRole.SUPER_ADMIN ||
      actor.status !== AdminAccountStatus.ACTIVE ||
      actor.mfaStatus !== AdminMfaStatus.ACTIVE ||
      !target ||
      target.role !== AdminRole.ADMIN ||
      target.status !== AdminAccountStatus.ACTIVE ||
      target.mfaStatus !== AdminMfaStatus.ACTIVE
    ) {
      throw new UnauthorizedException('Không được phép reset MFA Admin');
    }

    return this.issueRecoveryGrant({
      target,
      purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
      source: input.source,
      actor: input.actor,
      reasonCode: this.normalizeReason(input.reasonCode),
      beforeTransaction: (mongoSession) =>
        this.reauth.consumeInTransaction({
          rawGrant: input.reauthGrant,
          adminAccountId: actor._id,
          adminPublicId: actor.publicId,
          sessionPublicId: input.actorSessionPublicId,
          credentialVersion: actor.credentialVersion,
          authzVersion: actor.authzVersion,
          permissionVersion: actor.permissionVersion,
          purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
          targetPublicId: target.publicId,
          actor: input.actor,
          source: input.source,
          mongoSession,
        }),
    });
  }

  async executeBreakGlass(
    input: BreakGlassRecoveryInput,
  ): Promise<AdminRecoveryGrantResult> {
    const request = this.normalizeBreakGlass(input);
    const target = await this.loadByPublicId(input.targetAdminPublicId);
    if (!this.isBreakGlassEligible(target)) {
      throw new ConflictException('Không thể khôi phục SuperAdmin mục tiêu');
    }
    return this.issueRecoveryGrant({
      target,
      purpose: AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS,
      source: AdminAuditSource.CLI,
      actor: {
        type: AdminAuditActorType.DEPLOYMENT_OPERATOR,
        displayName: request.operatorReference,
      },
      reasonCode: 'super_admin_break_glass_approved',
      reasonNote: request.approvalReference,
      correlationId: request.correlationId,
    });
  }

  async inspectBreakGlass(input: BreakGlassRecoveryInput): Promise<
    Readonly<{
      eligible: boolean;
      targetAdminPublicId: string;
      currentStatus?: AdminAccountStatus;
      currentMfaStatus?: AdminMfaStatus;
    }>
  > {
    this.normalizeBreakGlass(input);
    const target = await this.loadByPublicId(input.targetAdminPublicId);
    const eligible = this.isBreakGlassEligible(target);
    return Object.freeze({
      eligible,
      targetAdminPublicId: input.targetAdminPublicId,
      ...(target
        ? {
            currentStatus: target.status,
            currentMfaStatus: target.mfaStatus,
          }
        : {}),
    });
  }

  async beginEnrollment(
    input: BeginRecoveryGrantEnrollmentInput,
  ): Promise<AdminRecoveryEnrollmentChallenge> {
    const accountLabel = this.normalizeAccountLabel(input.accountLabel);
    if (
      !isValidAdminPublicId(input.targetAdminPublicId) ||
      !Object.values(AdminRecoveryPurpose).includes(input.purpose)
    ) {
      throw this.invalidGrant();
    }
    const identity = {
      accountKey: input.targetAdminPublicId,
      trustedClientIp: input.trustedClientIp,
    };
    await this.loginProtection.assertAllowed(identity);
    const account = await this.loadByPublicId(input.targetAdminPublicId);
    if (
      !account ||
      account.status !== AdminAccountStatus.ACTIVE ||
      account.mfaStatus !== AdminMfaStatus.RESET_REQUIRED
    ) {
      await this.loginProtection.recordFailure(identity);
      throw this.invalidGrant();
    }
    let hash: string;
    try {
      hash = this.recoveryHash(input.rawGrant, input.purpose, account.publicId);
    } catch (error: unknown) {
      await this.loginProtection.recordFailure(identity);
      throw error;
    }
    const isBreakGlass =
      input.purpose === AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS;
    const passwordHash = isBreakGlass
      ? await this.hashValidatedPassword(input.newPassword)
      : undefined;
    if (!isBreakGlass && input.newPassword !== undefined) {
      throw new TypeError('MFA reset không được thay đổi mật khẩu');
    }
    const secret = this.crypto.generateTotpSecret();
    const encrypted = this.crypto.encryptTotpSecret(secret, account.publicId);
    const expiresAt = new Date(
      Date.now() + ADMIN_RECOVERY_GRANT_TTL_SECONDS * 1_000,
    );

    try {
      await this.connection.transaction(async (mongoSession) => {
        const grant = await this.grants
          .findOne({
            targetAdminAccountId: account._id,
            targetAdminPublicId: account.publicId,
            purpose: input.purpose,
            grantHash: hash,
            credentialVersionAtIssue: account.credentialVersion,
            consumedAt: null,
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          })
          .session(mongoSession);
        if (!grant) throw this.invalidGrant();

        const credentialIncrement = passwordHash ? 1 : 0;
        const result = await this.accounts.updateOne(
          {
            _id: account._id,
            publicId: account.publicId,
            status: AdminAccountStatus.ACTIVE,
            mfaStatus: AdminMfaStatus.RESET_REQUIRED,
            credentialVersion: account.credentialVersion,
            version: account.version,
          },
          {
            $set: {
              mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
              pendingEncryptedTotpSecret: encrypted,
              pendingTotpEnrollmentExpiresAt: expiresAt,
              ...(passwordHash
                ? { passwordHash, mustChangePassword: false }
                : {}),
            },
            $inc: {
              credentialVersion: credentialIncrement,
              version: 1,
            },
          },
          { session: mongoSession, runValidators: true },
        );
        if (result.modifiedCount !== 1) throw this.invalidGrant();
        if (credentialIncrement > 0) {
          await this.grants.updateOne(
            {
              _id: grant._id,
              credentialVersionAtIssue: account.credentialVersion,
            },
            {
              $set: { credentialVersionAtIssue: account.credentialVersion + 1 },
            },
            { session: mongoSession },
          );
        }
      });
      return this.challenge(secret, accountLabel, expiresAt, input.rawGrant);
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        await this.loginProtection.recordFailure(identity);
      }
      this.rethrow(error);
    }
  }

  async confirmEnrollment(
    input: ConfirmRecoveryEnrollmentInput,
  ): Promise<readonly string[]> {
    const identity = {
      accountKey: input.targetAdminPublicId,
      trustedClientIp: input.trustedClientIp,
    };
    await this.loginProtection.assertAllowed(identity);
    const account = await this.loadByPublicId(input.targetAdminPublicId, true);
    if (
      !account ||
      account.status !== AdminAccountStatus.ACTIVE ||
      account.mfaStatus !== AdminMfaStatus.PENDING_ENROLLMENT
    ) {
      await this.loginProtection.recordFailure(identity);
      throw this.invalidGrant();
    }
    const purposes = Object.values(AdminRecoveryPurpose);
    try {
      return await this.connection.transaction(async (mongoSession) => {
        const now = new Date();
        const stored = await this.accounts
          .findOne({ _id: account._id, publicId: account.publicId })
          .select('+pendingEncryptedTotpSecret +pendingTotpEnrollmentExpiresAt')
          .session(mongoSession)
          .lean<
            RecoveryAccount & {
              pendingEncryptedTotpSecret?: string;
              pendingTotpEnrollmentExpiresAt?: Date;
            }
          >()
          .exec();
        if (
          !stored?.pendingEncryptedTotpSecret ||
          !stored.pendingTotpEnrollmentExpiresAt ||
          stored.pendingTotpEnrollmentExpiresAt <= now
        ) {
          throw this.invalidGrant();
        }

        const candidateHashes = purposes.map((purpose) => ({
          purpose,
          hash: this.recoveryHash(input.rawGrant, purpose, account.publicId),
        }));
        const grant = await this.grants
          .findOne({
            targetAdminAccountId: account._id,
            targetAdminPublicId: account.publicId,
            $or: candidateHashes.map(({ purpose, hash }) => ({
              purpose,
              grantHash: hash,
            })),
            credentialVersionAtIssue: account.credentialVersion,
            consumedAt: null,
            revokedAt: null,
            expiresAt: { $gt: now },
          })
          .session(mongoSession);
        if (!grant) throw this.invalidGrant();

        const secret = this.crypto.decryptTotpSecret(
          stored.pendingEncryptedTotpSecret,
          account.publicId,
        );
        const step = findMatchingAdminTotpStep({
          secret,
          token: input.token,
          now,
          periodSeconds: this.policy.mfa.periodSeconds,
          digits: this.policy.mfa.digits,
          acceptedPastSteps: this.policy.mfa.acceptedPastSteps,
          acceptedFutureSteps: this.policy.mfa.acceptedFutureSteps,
        });
        if (step === null) throw this.invalidGrant();
        const recoveryCodes = this.crypto.generateRecoveryCodes(
          this.policy.mfa.recoveryCodeCount,
        );
        const recoveryCodeHashes = recoveryCodes.map((code) =>
          this.crypto.hashRecoveryCode(code),
        );
        const grantResult = await this.grants.updateOne(
          { _id: grant._id, consumedAt: null, revokedAt: null },
          { $set: { consumedAt: now } },
          { session: mongoSession },
        );
        const accountResult = await this.accounts.updateOne(
          {
            _id: account._id,
            publicId: account.publicId,
            mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
            pendingEncryptedTotpSecret: stored.pendingEncryptedTotpSecret,
          },
          {
            $set: {
              mfaStatus: AdminMfaStatus.ACTIVE,
              encryptedTotpSecret: stored.pendingEncryptedTotpSecret,
              totpLastUsedStep: step,
              recoveryCodeHashes,
            },
            $unset: {
              pendingEncryptedTotpSecret: 1,
              pendingTotpEnrollmentExpiresAt: 1,
            },
            $inc: { version: 1 },
          },
          { session: mongoSession, runValidators: true },
        );
        if (
          grantResult.modifiedCount !== 1 ||
          accountResult.modifiedCount !== 1
        ) {
          throw this.invalidGrant();
        }
        await this.audit.record({
          action: AdminAuditAction.MFA_ENROLLED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: {
            type: AdminAuditActorType.SYSTEM,
            displayName: 'Admin recovery workflow',
          },
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: account.publicId,
          },
          reasonCode: 'admin_recovery_enrollment_completed',
          source: input.source,
          mongoSession,
        });
        await this.loginProtection.clearAccountFailuresInTransaction(
          account.publicId,
          mongoSession,
        );
        return Object.freeze(recoveryCodes);
      });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        await this.loginProtection.recordFailure(identity);
      }
      this.rethrow(error);
    }
  }

  private async issueRecoveryGrant(input: {
    target: RecoveryAccount;
    purpose: AdminRecoveryPurpose;
    source: AdminAuditSource;
    actor: Parameters<AdminAuditService['record']>[0]['actor'];
    reasonCode: string;
    reasonNote?: string;
    correlationId?: string;
    beforeTransaction?: (
      session: Parameters<
        AdminReauthService['consumeInTransaction']
      >[0]['mongoSession'],
    ) => Promise<void>;
  }): Promise<AdminRecoveryGrantResult> {
    this.secretStore.assertReady();
    const rawGrant = generateAdminSecurityGrant();
    const expiresAt = new Date(
      Date.now() + ADMIN_RECOVERY_GRANT_TTL_SECONDS * 1_000,
    );
    const grantHash = hashAdminRecoveryGrant({
      rawGrant,
      purpose: input.purpose,
      targetPublicId: input.target.publicId,
      environment: this.policy.environment,
    });
    const secretReference = await this.secretStore.putVersion({
      secretName:
        `betta/admin/recovery/${this.policy.environment}/` +
        input.target.publicId.toLowerCase(),
      rawGrant,
      expiresAt,
      purpose: input.purpose,
      targetPublicId: input.target.publicId,
    });

    try {
      await this.connection.transaction(async (mongoSession) => {
        await input.beforeTransaction?.(mongoSession);
        const now = new Date();
        await this.grants.updateMany(
          {
            targetAdminAccountId: input.target._id,
            consumedAt: null,
            revokedAt: null,
          },
          { $set: { revokedAt: now } },
          { session: mongoSession },
        );
        const updated = await this.accounts.updateOne(
          {
            _id: input.target._id,
            publicId: input.target.publicId,
            role: input.target.role,
            status: input.target.status,
            credentialVersion: input.target.credentialVersion,
            version: input.target.version,
          },
          {
            $set: {
              status: AdminAccountStatus.ACTIVE,
              mfaStatus: AdminMfaStatus.RESET_REQUIRED,
              mustChangePassword:
                input.purpose === AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS,
              lockedAt: null,
              recoveryCodeHashes: [],
            },
            $unset: {
              encryptedTotpSecret: 1,
              pendingEncryptedTotpSecret: 1,
              pendingTotpEnrollmentExpiresAt: 1,
              totpLastUsedStep: 1,
            },
            $inc: { credentialVersion: 1, version: 1 },
          },
          { session: mongoSession, runValidators: true },
        );
        if (updated.modifiedCount !== 1) {
          throw new ConflictException('Admin recovery state đã thay đổi');
        }
        await this.grants.create(
          [
            {
              targetAdminAccountId: input.target._id,
              targetAdminPublicId: input.target.publicId,
              purpose: input.purpose,
              grantHash,
              credentialVersionAtIssue: input.target.credentialVersion + 1,
              secretReference,
              expiresAt,
              consumedAt: null,
              revokedAt: null,
            },
          ],
          { session: mongoSession },
        );
        await this.sessions.revokeAllInTransaction({
          targetAdminAccountId: input.target._id,
          targetAdminPublicId: input.target.publicId,
          reason: AdminSessionRevokeReason.MFA_RESET,
          auditActor: input.actor,
          auditSource: input.source,
          mongoSession,
        });
        await this.audit.record({
          action:
            input.purpose === AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS
              ? AdminAuditAction.BREAK_GLASS_RECOVERY
              : AdminAuditAction.MFA_RESET,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: input.actor,
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: input.target.publicId,
          },
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote,
          metadata: {
            beforeState: input.target.mfaStatus,
            afterState: AdminMfaStatus.RESET_REQUIRED,
          },
          correlationId: input.correlationId,
          source: input.source,
          mongoSession,
        });
      });
    } catch (error: unknown) {
      await this.compensate(secretReference);
      this.rethrow(error);
    }
    return Object.freeze({
      secretReference,
      expiresAt: expiresAt.toISOString(),
    });
  }

  private async loadAccount(
    id: Types.ObjectId,
    publicId: string,
  ): Promise<RecoveryAccount | null> {
    try {
      return await this.accounts
        .findOne({ _id: id, publicId, deletedAt: null })
        .select(
          '+credentialVersion +authzVersion +permissionVersion +version +activationGrantConsumedAt',
        )
        .lean<RecoveryAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async loadByPublicId(
    publicId: string,
    includePending = false,
  ): Promise<RecoveryAccount | null> {
    if (!isValidAdminPublicId(publicId)) return null;
    try {
      return await this.accounts
        .findOne({
          publicId,
          deletedAt: null,
          ...(includePending
            ? { mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT }
            : {}),
        })
        .select(
          '+credentialVersion +authzVersion +permissionVersion +version +activationGrantConsumedAt',
        )
        .lean<RecoveryAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private challenge(
    secret: Buffer,
    rawLabel: string,
    expiresAt: Date,
    confirmationGrant: string,
  ): AdminRecoveryEnrollmentChallenge {
    const label = rawLabel;
    const secretBase32 = encodeAdminTotpSecret(secret);
    const parameters = new URLSearchParams({
      secret: secretBase32,
      issuer: 'Betta',
      algorithm: this.policy.mfa.algorithm,
      digits: String(this.policy.mfa.digits),
      period: String(this.policy.mfa.periodSeconds),
    });
    return Object.freeze({
      secretBase32,
      otpauthUri: `otpauth://totp/${encodeURIComponent(`Betta:${label}`)}?${parameters.toString()}`,
      expiresAt,
      confirmationGrant,
    });
  }

  private normalizeAccountLabel(value: unknown): string {
    const label = typeof value === 'string' ? value.trim() : '';
    if (!label || label.length > 128) {
      throw new TypeError('Admin recovery account label không hợp lệ');
    }
    return label;
  }

  private async hashValidatedPassword(password: unknown): Promise<string> {
    if (
      typeof password !== 'string' ||
      password.length < ADMIN_PASSWORD_MIN_LENGTH ||
      password.length > ADMIN_PASSWORD_MAX_LENGTH ||
      Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_UTF8_BYTES ||
      !ADMIN_PASSWORD_COMPLEXITY_PATTERN.test(password)
    ) {
      throw new TypeError('Mật khẩu Admin không đáp ứng chính sách bảo mật');
    }
    return bcrypt.hash(password, ADMIN_PASSWORD_BCRYPT_ROUNDS);
  }

  private isBreakGlassEligible(
    target: RecoveryAccount | null,
  ): target is RecoveryAccount {
    return Boolean(
      target &&
      target.role === AdminRole.SUPER_ADMIN &&
      (target.status === AdminAccountStatus.ACTIVE ||
        target.status === AdminAccountStatus.LOCKED) &&
      target.activationGrantConsumedAt instanceof Date &&
      !Number.isNaN(target.activationGrantConsumedAt.getTime()),
    );
  }

  private normalizeBreakGlass(input: BreakGlassRecoveryInput) {
    const operatorReference = input.operatorReference?.trim();
    const approvalReference = input.approvalReference?.trim();
    const correlationId = input.correlationId?.trim();
    if (
      !isValidAdminPublicId(input.targetAdminPublicId) ||
      !OPERATOR_REFERENCE_PATTERN.test(operatorReference ?? '') ||
      !APPROVAL_REFERENCE_PATTERN.test(approvalReference ?? '') ||
      (correlationId !== undefined && !CORRELATION_PATTERN.test(correlationId))
    ) {
      throw new TypeError('Break-glass recovery input không hợp lệ');
    }
    return Object.freeze({
      operatorReference,
      approvalReference,
      correlationId,
    });
  }

  private normalizeReason(reason: string): string {
    const normalized = reason.trim();
    if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(normalized)) {
      throw new TypeError('Admin recovery reason code không hợp lệ');
    }
    return normalized;
  }

  private recoveryHash(
    rawGrant: string,
    purpose: AdminRecoveryPurpose,
    targetPublicId: string,
  ): string {
    try {
      return hashAdminRecoveryGrant({
        rawGrant,
        purpose,
        targetPublicId,
        environment: this.policy.environment,
      });
    } catch {
      throw this.invalidGrant();
    }
  }

  private async compensate(secretReference: string): Promise<void> {
    try {
      await this.secretStore.revokeVersion(secretReference);
    } catch {
      throw new ServiceUnavailableException(
        'Admin recovery thất bại; cần kiểm tra Secret Manager',
      );
    }
  }

  private invalidGrant(): UnauthorizedException {
    return new UnauthorizedException(
      'Recovery grant không hợp lệ hoặc đã hết hạn',
    );
  }

  private rethrow(error: unknown): never {
    if (
      error instanceof UnauthorizedException ||
      error instanceof ConflictException ||
      error instanceof TypeError ||
      error instanceof ServiceUnavailableException
    ) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ khôi phục Admin tạm thời không khả dụng',
      );
    }
    throw new ServiceUnavailableException('Không thể hoàn tất Admin recovery');
  }
}
