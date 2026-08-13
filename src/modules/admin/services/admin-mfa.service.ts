import {
  Inject,
  Injectable,
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
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  AdminAuditActorType,
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
  type AdminAuditSource,
} from '../constants/admin-audit.constants';
import {
  ADMIN_TOTP_ENROLLMENT_TTL_MS,
  AdminMfaEnrollmentMode,
} from '../constants/admin-mfa.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import { type AdminAuditActorInput } from '../interfaces/admin-audit.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import {
  encodeAdminTotpSecret,
  findMatchingAdminTotpStep,
} from '../utils/admin-totp';
import { AdminAuditService } from './admin-audit.service';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';
import { AdminSessionService } from './admin-session.service';

type EnrollmentAccount = Pick<
  AdminAccount,
  | 'publicId'
  | 'status'
  | 'mfaStatus'
  | 'pendingEncryptedTotpSecret'
  | 'pendingTotpEnrollmentExpiresAt'
> & { _id: Types.ObjectId };

export type BeginAdminMfaEnrollmentInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  mode: AdminMfaEnrollmentMode;
  currentTotpToken?: string;
  accountLabel: string;
  issuer?: string;
}>;

export type ConfirmAdminMfaEnrollmentInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  token: string;
  auditActor: AdminMfaAuditActor;
  auditSource: AdminAuditSource;
}>;

export type AdminMfaEnrollmentChallenge = Readonly<{
  secretBase32: string;
  otpauthUri: string;
  expiresAt: Date;
}>;

export type ConsumeAdminRecoveryCodeInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  recoveryCode: string;
  auditActor: AdminMfaAuditActor;
  auditSource: AdminAuditSource;
}>;

export type AdminMfaAuditActor = AdminAuditActorInput &
  Readonly<{
    type: AdminAuditActorType.ADMIN_ACCOUNT;
    publicId: string;
    username: string;
    role: AdminRole;
    permissionVersion: number;
  }>;

@Injectable()
export class AdminMfaService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accountModel: Model<AdminAccount>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    private readonly crypto: AdminMfaCryptoService,
    private readonly audit: AdminAuditService,
    private readonly sessions: AdminSessionService,
  ) {}

  async beginEnrollment(
    input: BeginAdminMfaEnrollmentInput,
  ): Promise<AdminMfaEnrollmentChallenge> {
    this.assertIdentity(input.adminAccountId, input.adminPublicId);
    const label = input.accountLabel.trim();
    const issuer = (input.issuer ?? 'Betta').trim();
    if (!label || label.length > 128 || !issuer || issuer.length > 64) {
      throw new TypeError('Admin MFA enrollment label không hợp lệ');
    }

    const isReenrollment =
      input.mode === AdminMfaEnrollmentMode.ACTIVE_REENROLLMENT;
    let reenrollmentProofEnvelope: string | undefined;
    if (
      input.mode !== AdminMfaEnrollmentMode.INITIAL_ENROLLMENT &&
      !isReenrollment
    ) {
      throw new TypeError('Admin MFA enrollment mode không hợp lệ');
    }
    if (isReenrollment) {
      reenrollmentProofEnvelope =
        (await this.verifyTotpCredential(
          input.adminAccountId,
          input.adminPublicId,
          input.currentTotpToken ?? '',
          new Date(),
        )) ?? undefined;
      if (!reenrollmentProofEnvelope) throw this.invalidChallenge();
    } else if (input.currentTotpToken !== undefined) {
      throw new TypeError('Initial MFA enrollment không nhận current TOTP');
    }

    const secret = this.crypto.generateTotpSecret();
    const encrypted = this.crypto.encryptTotpSecret(
      secret,
      input.adminPublicId,
    );
    const expiresAt = new Date(Date.now() + ADMIN_TOTP_ENROLLMENT_TTL_MS);

    try {
      const updated = await this.accountModel
        .findOneAndUpdate(
          {
            _id: input.adminAccountId,
            publicId: input.adminPublicId,
            status: isReenrollment
              ? AdminAccountStatus.ACTIVE
              : AdminAccountStatus.PENDING_ACTIVATION,
            mfaStatus: isReenrollment
              ? AdminMfaStatus.ACTIVE
              : {
                  $in: [
                    AdminMfaStatus.NOT_ENROLLED,
                    AdminMfaStatus.PENDING_ENROLLMENT,
                  ],
                },
            ...(isReenrollment
              ? { encryptedTotpSecret: reenrollmentProofEnvelope }
              : {}),
          },
          {
            $set: {
              pendingEncryptedTotpSecret: encrypted,
              pendingTotpEnrollmentExpiresAt: expiresAt,
              mfaStatus: isReenrollment
                ? AdminMfaStatus.ACTIVE
                : AdminMfaStatus.PENDING_ENROLLMENT,
            },
          },
          { returnDocument: 'after', runValidators: true },
        )
        .select('+pendingEncryptedTotpSecret +pendingTotpEnrollmentExpiresAt')
        .lean<EnrollmentAccount>()
        .exec();
      if (!updated) throw this.invalidChallenge();
    } catch (error: unknown) {
      this.rethrow(error);
    }

    const secretBase32 = encodeAdminTotpSecret(secret);
    const parameters = new URLSearchParams({
      secret: secretBase32,
      issuer,
      algorithm: this.policy.mfa.algorithm,
      digits: String(this.policy.mfa.digits),
      period: String(this.policy.mfa.periodSeconds),
    });
    return Object.freeze({
      secretBase32,
      otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?${parameters.toString()}`,
      expiresAt,
    });
  }

  async confirmEnrollment(
    input: ConfirmAdminMfaEnrollmentInput,
  ): Promise<readonly string[]> {
    this.assertIdentity(input.adminAccountId, input.adminPublicId);
    try {
      return await this.connection.transaction(async (mongoSession) => {
        const account = await this.accountModel
          .findOne({
            _id: input.adminAccountId,
            publicId: input.adminPublicId,
            status: {
              $in: [
                AdminAccountStatus.PENDING_ACTIVATION,
                AdminAccountStatus.ACTIVE,
              ],
            },
          })
          .select(
            '+pendingEncryptedTotpSecret +pendingTotpEnrollmentExpiresAt +credentialVersion',
          )
          .session(mongoSession)
          .lean<EnrollmentAccount & { credentialVersion: number }>()
          .exec();
        const now = new Date();
        if (
          !account?.pendingEncryptedTotpSecret ||
          !account.pendingTotpEnrollmentExpiresAt ||
          account.pendingTotpEnrollmentExpiresAt <= now
        ) {
          throw this.invalidChallenge();
        }

        const secret = this.crypto.decryptTotpSecret(
          account.pendingEncryptedTotpSecret,
          account.publicId,
        );
        const step = this.matchStep(secret, input.token, now);
        if (step === null) throw this.invalidChallenge();
        const recoveryCodes = this.crypto.generateRecoveryCodes(
          this.policy.mfa.recoveryCodeCount,
        );
        const recoveryCodeHashes = recoveryCodes.map((code) =>
          this.crypto.hashRecoveryCode(code),
        );
        const wasActive = account.mfaStatus === AdminMfaStatus.ACTIVE;
        const result = await this.accountModel.updateOne(
          {
            _id: account._id,
            publicId: account.publicId,
            pendingEncryptedTotpSecret: account.pendingEncryptedTotpSecret,
            pendingTotpEnrollmentExpiresAt: { $gt: now },
          },
          {
            $set: {
              encryptedTotpSecret: account.pendingEncryptedTotpSecret,
              mfaStatus: AdminMfaStatus.ACTIVE,
              totpLastUsedStep: step,
              recoveryCodeHashes,
            },
            $unset: {
              pendingEncryptedTotpSecret: 1,
              pendingTotpEnrollmentExpiresAt: 1,
            },
            ...(wasActive ? { $inc: { credentialVersion: 1 } } : {}),
          },
          { session: mongoSession, runValidators: true },
        );
        if (result.modifiedCount !== 1) throw this.invalidChallenge();

        if (wasActive) {
          await this.sessions.revokeAllInTransaction({
            targetAdminAccountId: account._id,
            targetAdminPublicId: account.publicId,
            reason: AdminSessionRevokeReason.MFA_RESET,
            auditActor: input.auditActor,
            mongoSession,
          });
        }
        await this.audit.record({
          action: AdminAuditAction.MFA_ENROLLED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: input.auditActor,
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: account.publicId,
          },
          reasonCode: wasActive ? 'admin_mfa_reenrolled' : 'admin_mfa_enrolled',
          metadata: {
            beforeState: account.mfaStatus,
            afterState: AdminMfaStatus.ACTIVE,
          },
          source: input.auditSource,
          mongoSession,
        });
        return recoveryCodes;
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async verifyTotp(
    adminAccountId: Types.ObjectId,
    adminPublicId: string,
    token: string,
    now = new Date(),
  ): Promise<boolean> {
    return Boolean(
      await this.verifyTotpCredential(
        adminAccountId,
        adminPublicId,
        token,
        now,
        undefined,
      ),
    );
  }

  async verifyTotpInTransaction(
    adminAccountId: Types.ObjectId,
    adminPublicId: string,
    token: string,
    mongoSession: ClientSession,
    now = new Date(),
  ): Promise<boolean> {
    if (mongoSession?.inTransaction() !== true) {
      throw new TypeError('Admin MFA verification yeu cau transaction active');
    }
    return Boolean(
      await this.verifyTotpCredential(
        adminAccountId,
        adminPublicId,
        token,
        now,
        mongoSession,
      ),
    );
  }

  private async verifyTotpCredential(
    adminAccountId: Types.ObjectId,
    adminPublicId: string,
    token: string,
    now: Date,
    mongoSession?: ClientSession,
  ): Promise<string | null> {
    this.assertIdentity(adminAccountId, adminPublicId);
    try {
      const accountQuery = this.accountModel
        .findOne({
          _id: adminAccountId,
          publicId: adminPublicId,
          mfaStatus: AdminMfaStatus.ACTIVE,
        })
        .select('+encryptedTotpSecret +totpLastUsedStep');
      if (mongoSession) accountQuery.session(mongoSession);

      const account = await accountQuery
        .lean<Pick<AdminAccount, 'encryptedTotpSecret' | 'totpLastUsedStep'>>()
        .exec();
      if (!account?.encryptedTotpSecret) return null;
      const secret = this.crypto.decryptTotpSecret(
        account.encryptedTotpSecret,
        adminPublicId,
      );
      const step = this.matchStep(secret, token, now);
      if (step === null) return null;
      const replayFilter = {
        _id: adminAccountId,
        publicId: adminPublicId,
        mfaStatus: AdminMfaStatus.ACTIVE,
        encryptedTotpSecret: account.encryptedTotpSecret,
        $or: [
          { totpLastUsedStep: null },
          { totpLastUsedStep: { $exists: false } },
          { totpLastUsedStep: { $lt: step } },
        ],
      };
      const replayUpdate = { $set: { totpLastUsedStep: step } };
      const result = mongoSession
        ? await this.accountModel.updateOne(replayFilter, replayUpdate, {
            session: mongoSession,
          })
        : await this.accountModel.updateOne(replayFilter, replayUpdate);
      return result.modifiedCount === 1 ? account.encryptedTotpSecret : null;
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async consumeRecoveryCode(
    input: ConsumeAdminRecoveryCodeInput,
  ): Promise<boolean> {
    this.assertIdentity(input.adminAccountId, input.adminPublicId);
    const recoveryHash = this.crypto.hashRecoveryCode(input.recoveryCode);
    try {
      return await this.connection.transaction(async (mongoSession) => {
        const account = await this.accountModel
          .findOneAndUpdate(
            {
              _id: input.adminAccountId,
              publicId: input.adminPublicId,
              mfaStatus: AdminMfaStatus.ACTIVE,
              recoveryCodeHashes: recoveryHash,
            },
            {
              $pull: { recoveryCodeHashes: recoveryHash },
              $inc: { credentialVersion: 1 },
            },
            {
              returnDocument: 'after',
              session: mongoSession,
              runValidators: true,
            },
          )
          .select('+credentialVersion')
          .lean<{ _id: Types.ObjectId; publicId: string }>()
          .exec();
        if (!account) return false;

        await this.sessions.revokeAllInTransaction({
          targetAdminAccountId: account._id,
          targetAdminPublicId: account.publicId,
          reason: AdminSessionRevokeReason.MFA_RESET,
          auditActor: input.auditActor,
          mongoSession,
        });
        await this.audit.record({
          action: AdminAuditAction.MFA_RECOVERY_USED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: input.auditActor,
          target: {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: account.publicId,
          },
          reasonCode: 'admin_mfa_recovery_used',
          source: input.auditSource,
          mongoSession,
        });
        return true;
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private matchStep(secret: Buffer, token: string, now: Date): number | null {
    return findMatchingAdminTotpStep({
      secret,
      token,
      now,
      periodSeconds: this.policy.mfa.periodSeconds,
      digits: this.policy.mfa.digits,
      acceptedPastSteps: this.policy.mfa.acceptedPastSteps,
      acceptedFutureSteps: this.policy.mfa.acceptedFutureSteps,
    });
  }

  private assertIdentity(id: Types.ObjectId, publicId: string): void {
    if (!Types.ObjectId.isValid(id) || !isValidAdminPublicId(publicId)) {
      throw new TypeError('Admin MFA identity không hợp lệ');
    }
  }

  private invalidChallenge(): UnauthorizedException {
    return new UnauthorizedException(
      'Mã xác thực không hợp lệ hoặc đã hết hạn',
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof UnauthorizedException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ xác thực tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
