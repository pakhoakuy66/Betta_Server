import {
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
} from '../constants/admin-account.constants';
import {
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  ADMIN_PASSWORD_COMPLEXITY_PATTERN,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MAX_UTF8_BYTES,
  ADMIN_PASSWORD_MIN_LENGTH,
  AdminRecoveryPurpose,
} from '../constants/admin-account-recovery.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { ADMIN_TOTP_ENROLLMENT_TTL_MS } from '../constants/admin-mfa.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import {
  type AdminRecoveryEnrollmentChallenge,
  type BeginRecoveryCodeEnrollmentInput,
  type ChangeAdminPasswordInput,
} from '../interfaces/admin-account-recovery.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminRecoveryGrant } from '../schemas/admin-recovery-grant.schema';
import { encodeAdminTotpSecret } from '../utils/admin-totp';
import {
  generateAdminSecurityGrant,
  hashAdminRecoveryGrant,
} from '../utils/admin-security-grant';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminLoginProtectionService } from './admin-login-protection.service';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';
import { AdminMfaService } from './admin-mfa.service';
import { AdminSessionService } from './admin-session.service';

type CredentialAccount = Pick<
  AdminAccount,
  | 'publicId'
  | 'passwordHash'
  | 'credentialVersion'
  | 'version'
  | 'recoveryCodeHashes'
> & { _id: Types.ObjectId };

@Injectable()
export class AdminCredentialService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminRecoveryGrant.name)
    private readonly recoveryGrants: Model<AdminRecoveryGrant>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    private readonly mfa: AdminMfaService,
    private readonly mfaCrypto: AdminMfaCryptoService,
    private readonly sessions: AdminSessionService,
    private readonly audit: AdminAuditService,
    private readonly loginProtection: AdminLoginProtectionService,
  ) {}

  async changePassword(input: ChangeAdminPasswordInput): Promise<void> {
    this.assertIdentity(input.adminAccountId, input.adminPublicId);
    this.assertPassword(input.newPassword);
    if (input.currentPassword === input.newPassword) {
      throw new TypeError('Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    const identity = {
      accountKey: input.adminPublicId,
      trustedClientIp: input.trustedClientIp,
    };
    await this.loginProtection.assertAllowed(identity);

    const snapshot = await this.loadActiveCredential(input);
    const matches = Boolean(
      snapshot?.passwordHash &&
      (await bcrypt.compare(input.currentPassword, snapshot.passwordHash)),
    );
    if (!snapshot || !matches) {
      await this.loginProtection.recordFailure(identity);
      throw this.invalidCredential();
    }
    const newHash = await bcrypt.hash(
      input.newPassword,
      ADMIN_PASSWORD_BCRYPT_ROUNDS,
    );

    let totpRejected = false;
    try {
      await this.connection.transaction(async (mongoSession) => {
        const verified = await this.mfa.verifyTotpInTransaction(
          input.adminAccountId,
          input.adminPublicId,
          input.totpToken,
          mongoSession,
        );
        if (!verified) {
          totpRejected = true;
          throw this.invalidCredential();
        }

        const result = await this.accounts.updateOne(
          {
            _id: snapshot._id,
            publicId: snapshot.publicId,
            status: AdminAccountStatus.ACTIVE,
            mfaStatus: AdminMfaStatus.ACTIVE,
            mustChangePassword: false,
            passwordHash: snapshot.passwordHash,
            credentialVersion: snapshot.credentialVersion,
            version: snapshot.version,
          },
          {
            $set: { passwordHash: newHash },
            $inc: { credentialVersion: 1, version: 1 },
          },
          { session: mongoSession, runValidators: true },
        );
        if (result.modifiedCount !== 1) throw this.invalidCredential();

        await this.sessions.revokeAllInTransaction({
          targetAdminAccountId: snapshot._id,
          targetAdminPublicId: snapshot.publicId,
          reason: AdminSessionRevokeReason.PASSWORD_CHANGED,
          auditActor: input.actor,
          auditSource: input.source,
          mongoSession,
        });
        await this.audit.record({
          action: AdminAuditAction.PASSWORD_CHANGED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: input.actor,
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: snapshot.publicId,
          },
          reasonCode: 'admin_password_changed',
          metadata: {
            beforeVersion: snapshot.credentialVersion,
            afterVersion: snapshot.credentialVersion + 1,
          },
          source: input.source,
          mongoSession,
        });
        await this.loginProtection.clearAccountFailuresInTransaction(
          snapshot.publicId,
          mongoSession,
        );
      });
    } catch (error: unknown) {
      if (totpRejected) {
        await this.loginProtection.recordFailure(identity);
      }
      this.rethrow(error);
    }
  }

  async beginRecoveryCodeEnrollment(
    input: BeginRecoveryCodeEnrollmentInput,
  ): Promise<AdminRecoveryEnrollmentChallenge> {
    this.assertIdentity(input.adminAccountId, input.adminPublicId);
    const accountLabel = this.normalizeAccountLabel(input.accountLabel);
    const identity = {
      accountKey: input.adminPublicId,
      trustedClientIp: input.trustedClientIp,
    };
    await this.loginProtection.assertAllowed(identity);

    const snapshot = await this.loadActiveCredential(input);
    const passwordMatches = Boolean(
      snapshot?.passwordHash &&
      (await bcrypt.compare(input.password, snapshot.passwordHash)),
    );
    const recoveryHash = this.mfaCrypto.hashRecoveryCode(input.recoveryCode);
    if (
      !snapshot ||
      !passwordMatches ||
      !snapshot.recoveryCodeHashes.includes(recoveryHash)
    ) {
      await this.loginProtection.recordFailure(identity);
      throw this.invalidCredential();
    }

    const secret = this.mfaCrypto.generateTotpSecret();
    const encrypted = this.mfaCrypto.encryptTotpSecret(
      secret,
      input.adminPublicId,
    );
    const expiresAt = new Date(Date.now() + ADMIN_TOTP_ENROLLMENT_TTL_MS);
    const confirmationGrant = generateAdminSecurityGrant();
    const confirmationHash = hashAdminRecoveryGrant({
      rawGrant: confirmationGrant,
      purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
      targetPublicId: snapshot.publicId,
      environment: this.policy.environment,
    });

    try {
      await this.connection.transaction(async (mongoSession) => {
        const updated = await this.accounts.updateOne(
          {
            _id: snapshot._id,
            publicId: snapshot.publicId,
            status: AdminAccountStatus.ACTIVE,
            mfaStatus: AdminMfaStatus.ACTIVE,
            passwordHash: snapshot.passwordHash,
            credentialVersion: snapshot.credentialVersion,
            version: snapshot.version,
            recoveryCodeHashes: recoveryHash,
          },
          {
            $set: {
              mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
              pendingEncryptedTotpSecret: encrypted,
              pendingTotpEnrollmentExpiresAt: expiresAt,
              recoveryCodeHashes: [],
            },
            $unset: { encryptedTotpSecret: 1, totpLastUsedStep: 1 },
            $inc: { credentialVersion: 1, version: 1 },
          },
          { session: mongoSession, runValidators: true },
        );
        if (updated.modifiedCount !== 1) throw this.invalidCredential();

        await this.recoveryGrants.updateMany(
          {
            targetAdminAccountId: snapshot._id,
            purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
            consumedAt: null,
            revokedAt: null,
          },
          { $set: { revokedAt: new Date() } },
          { session: mongoSession },
        );
        await this.recoveryGrants.create(
          [
            {
              targetAdminAccountId: snapshot._id,
              targetAdminPublicId: snapshot.publicId,
              purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
              grantHash: confirmationHash,
              credentialVersionAtIssue: snapshot.credentialVersion + 1,
              secretReference: 'inline:recovery-code',
              expiresAt,
              consumedAt: null,
              revokedAt: null,
            },
          ],
          { session: mongoSession },
        );

        await this.sessions.revokeAllInTransaction({
          targetAdminAccountId: snapshot._id,
          targetAdminPublicId: snapshot.publicId,
          reason: AdminSessionRevokeReason.MFA_RESET,
          auditActor: {
            type: AdminAuditActorType.SYSTEM,
            displayName: 'Admin recovery workflow',
          },
          auditSource: input.source,
          mongoSession,
        });
        await this.audit.record({
          action: AdminAuditAction.MFA_RECOVERY_USED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: {
            type: AdminAuditActorType.SYSTEM,
            displayName: 'Admin recovery workflow',
          },
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: snapshot.publicId,
          },
          reasonCode: 'admin_mfa_recovery_code_consumed',
          source: input.source,
          mongoSession,
        });
        await this.loginProtection.clearAccountFailuresInTransaction(
          input.adminPublicId,
          mongoSession,
        );
      });
      return this.challenge(secret, accountLabel, expiresAt, confirmationGrant);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async loadActiveCredential(input: {
    adminAccountId: Types.ObjectId;
    adminPublicId: string;
  }): Promise<CredentialAccount | null> {
    try {
      return await this.accounts
        .findOne({
          _id: input.adminAccountId,
          publicId: input.adminPublicId,
          status: AdminAccountStatus.ACTIVE,
          deletedAt: null,
          mustChangePassword: false,
          mfaStatus: AdminMfaStatus.ACTIVE,
        })
        .select(
          '_id publicId +passwordHash +credentialVersion +version +recoveryCodeHashes',
        )
        .lean<CredentialAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private challenge(
    secret: Buffer,
    labelValue: string,
    expiresAt: Date,
    confirmationGrant: string,
  ): AdminRecoveryEnrollmentChallenge {
    const label = labelValue;
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

  private assertPassword(password: unknown): asserts password is string {
    if (
      typeof password !== 'string' ||
      password.length < ADMIN_PASSWORD_MIN_LENGTH ||
      password.length > ADMIN_PASSWORD_MAX_LENGTH ||
      Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_UTF8_BYTES ||
      !ADMIN_PASSWORD_COMPLEXITY_PATTERN.test(password)
    ) {
      throw new TypeError('Mật khẩu Admin không đáp ứng chính sách bảo mật');
    }
  }

  private assertIdentity(id: Types.ObjectId, publicId: string): void {
    if (!Types.ObjectId.isValid(id) || !isValidAdminPublicId(publicId)) {
      throw new TypeError('Admin credential identity không hợp lệ');
    }
  }

  private invalidCredential(): UnauthorizedException {
    return new UnauthorizedException('Thông tin xác thực không hợp lệ');
  }

  private rethrow(error: unknown): never {
    if (error instanceof UnauthorizedException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ bảo mật Admin tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
