import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { timingSafeEqual } from 'node:crypto';
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
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  ADMIN_PASSWORD_COMPLEXITY_PATTERN,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MAX_UTF8_BYTES,
  ADMIN_PASSWORD_MIN_LENGTH,
} from '../constants/admin-account-recovery.constants';
import {
  ADMIN_ACTIVATION_ACCOUNT_KEY_PREFIX,
  ADMIN_ACTIVATION_INVALID_MESSAGE,
  ADMIN_ACTIVATION_ISSUER,
  ADMIN_ACTIVATION_PASSWORD_MISMATCH_MESSAGE,
  ADMIN_ACTIVATION_PASSWORD_POLICY_MESSAGE,
} from '../constants/admin-activation.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import { ADMIN_TOTP_ENROLLMENT_TTL_MS } from '../constants/admin-mfa.constants';
import {
  type AdminActivationChallenge,
  type AdminActivationCompletion,
  type BeginAdminActivationInput,
  type CompleteAdminActivationInput,
} from '../interfaces/admin-activation.interface';
import { type AdminSessionAccount } from '../interfaces/admin-session.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminBootstrapState } from '../schemas/admin-bootstrap-state.schema';
import {
  hashAdminActivationGrant,
  isCanonicalAdminActivationGrant,
} from '../utils/admin-activation-grant';
import {
  encodeAdminTotpSecret,
  findMatchingAdminTotpStep,
} from '../utils/admin-totp';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAccessTokenService } from './admin-access-token.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminLoginProtectionService } from './admin-login-protection.service';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';
import { AdminSessionService } from './admin-session.service';

type ActivationAccount = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  status: AdminAccountStatus;
  mustChangePassword: boolean;
  mfaStatus: AdminMfaStatus;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
  version: number;
  activationGrantHash: string;
  activationGrantExpiresAt: Date;
  activationGrantConsumedAt?: Date | null;
  pendingEncryptedTotpSecret?: string;
  pendingTotpEnrollmentExpiresAt?: Date;
}>;

type ActivationBootstrapState = Readonly<{
  _id: Types.ObjectId;
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  purpose: AdminActivationGrantPurpose;
  environment: AdminBootstrapEnvironment;
  grantHash: string;
  grantExpiresAt: Date;
  consumedAt?: Date | null;
}>;

type ActivationSnapshot = Readonly<{
  account: ActivationAccount;
  purpose: AdminActivationGrantPurpose;
  grantHash: string;
  bootstrapState?: ActivationBootstrapState;
}>;

@Injectable()
export class AdminActivationService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminBootstrapState.name)
    private readonly bootstrapStates: Model<AdminBootstrapState>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    private readonly mfaCrypto: AdminMfaCryptoService,
    private readonly loginProtection: AdminLoginProtectionService,
    private readonly sessions: AdminSessionService,
    private readonly accessTokens: AdminAccessTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  async begin(
    input: BeginAdminActivationInput,
  ): Promise<AdminActivationChallenge> {
    this.assertPublicInput(input.adminPublicId, input.activationGrant);
    const protectionIdentity = this.protectionIdentity(input);
    await this.loginProtection.assertAllowed(protectionIdentity);

    const snapshot = await this.loadSnapshot(
      input.adminPublicId,
      input.activationGrant,
      false,
    );
    if (!snapshot) return this.deny(protectionIdentity);

    const now = new Date();
    const secret = this.mfaCrypto.generateTotpSecret();
    const encryptedSecret = this.mfaCrypto.encryptTotpSecret(
      secret,
      snapshot.account.publicId,
    );
    const expiresAt = new Date(
      Math.min(
        snapshot.account.activationGrantExpiresAt.getTime(),
        now.getTime() + ADMIN_TOTP_ENROLLMENT_TTL_MS,
      ),
    );
    if (expiresAt <= now) return this.deny(protectionIdentity);

    try {
      const result = await this.accounts.updateOne(
        this.accountCasFilter(snapshot.account, now),
        {
          $set: {
            mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
            pendingEncryptedTotpSecret: encryptedSecret,
            pendingTotpEnrollmentExpiresAt: expiresAt,
          },
          $inc: { version: 1 },
        },
        { runValidators: true },
      );
      if (result.modifiedCount !== 1) return this.deny(protectionIdentity);
    } catch (error: unknown) {
      this.rethrow(error);
    }

    return this.toChallenge(snapshot.account, secret, expiresAt);
  }

  async complete(
    input: CompleteAdminActivationInput,
  ): Promise<AdminActivationCompletion> {
    this.assertPublicInput(input.adminPublicId, input.activationGrant);
    this.assertPassword(input.newPassword, input.confirmPassword);
    const protectionIdentity = this.protectionIdentity(input);
    await this.loginProtection.assertAllowed(protectionIdentity);

    const snapshot = await this.loadSnapshot(
      input.adminPublicId,
      input.activationGrant,
      true,
    );
    if (!snapshot?.account.pendingEncryptedTotpSecret) {
      return this.deny(protectionIdentity);
    }

    const now = new Date();
    const secret = this.mfaCrypto.decryptTotpSecret(
      snapshot.account.pendingEncryptedTotpSecret,
      snapshot.account.publicId,
    );
    const totpStep = findMatchingAdminTotpStep({
      secret,
      token: input.totpToken,
      now,
      periodSeconds: this.policy.mfa.periodSeconds,
      digits: this.policy.mfa.digits,
      acceptedPastSteps: this.policy.mfa.acceptedPastSteps,
      acceptedFutureSteps: this.policy.mfa.acceptedFutureSteps,
    });
    if (totpStep === null) return this.deny(protectionIdentity);

    const passwordHash = await bcrypt.hash(
      input.newPassword,
      ADMIN_PASSWORD_BCRYPT_ROUNDS,
    );
    const recoveryCodes = this.mfaCrypto.generateRecoveryCodes(
      this.policy.mfa.recoveryCodeCount,
    );
    const recoveryCodeHashes = recoveryCodes.map((code) =>
      this.mfaCrypto.hashRecoveryCode(code),
    );

    try {
      const authentication = await this.connection.transaction(
        async (mongoSession) =>
          this.completeInTransaction({
            snapshot,
            passwordHash,
            recoveryCodeHashes,
            totpStep,
            now,
            userAgent: input.userAgent,
            protectionAccountKey: protectionIdentity.accountKey,
            mongoSession,
          }),
      );
      return Object.freeze({ authentication, recoveryCodes });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        await this.loginProtection.recordFailure(protectionIdentity);
      }
      this.rethrow(error);
    }
  }

  private async completeInTransaction(input: {
    snapshot: ActivationSnapshot;
    passwordHash: string;
    recoveryCodeHashes: readonly string[];
    totpStep: number;
    now: Date;
    userAgent?: string;
    protectionAccountKey: string;
    mongoSession: ClientSession;
  }) {
    const { account } = input.snapshot;
    if (input.snapshot.bootstrapState) {
      const stateResult = await this.bootstrapStates.updateOne(
        {
          _id: input.snapshot.bootstrapState._id,
          key: ADMIN_BOOTSTRAP_SINGLETON_KEY,
          adminAccountId: account._id,
          adminPublicId: account.publicId,
          purpose: input.snapshot.purpose,
          environment: this.environment(),
          grantHash: input.snapshot.grantHash,
          grantExpiresAt: { $gt: input.now },
          consumedAt: null,
        },
        { $set: { consumedAt: input.now } },
        { session: input.mongoSession, runValidators: true },
      );
      if (stateResult.modifiedCount !== 1) throw this.invalidActivation();
    }

    const accountResult = await this.accounts.updateOne(
      {
        ...this.accountCasFilter(account, input.now),
        mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
        pendingEncryptedTotpSecret: account.pendingEncryptedTotpSecret,
        pendingTotpEnrollmentExpiresAt: { $gt: input.now },
      },
      {
        $set: {
          status: AdminAccountStatus.ACTIVE,
          passwordHash: input.passwordHash,
          mustChangePassword: false,
          mfaStatus: AdminMfaStatus.ACTIVE,
          encryptedTotpSecret: account.pendingEncryptedTotpSecret,
          totpLastUsedStep: input.totpStep,
          recoveryCodeHashes: input.recoveryCodeHashes,
          activationGrantConsumedAt: input.now,
        },
        $unset: {
          activationGrantHash: 1,
          activationGrantExpiresAt: 1,
          pendingEncryptedTotpSecret: 1,
          pendingTotpEnrollmentExpiresAt: 1,
        },
        $inc: { credentialVersion: 1, authzVersion: 1, version: 1 },
      },
      { session: input.mongoSession, runValidators: true },
    );
    if (accountResult.modifiedCount !== 1) throw this.invalidActivation();

    const activatedAccount: AdminSessionAccount = Object.freeze({
      _id: account._id,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      credentialVersion: account.credentialVersion + 1,
      authzVersion: account.authzVersion + 1,
      permissionVersion: account.permissionVersion,
    });

    await this.audit.record({
      action: AdminAuditAction.ACTIVATION_CONSUMED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Admin activation workflow',
      },
      target: {
        type: AdminAuditTargetType.ADMIN_ACCOUNT,
        publicId: account.publicId,
      },
      reasonCode:
        input.snapshot.purpose ===
        AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN
          ? 'initial_super_admin_activation_completed'
          : 'admin_account_activation_completed',
      metadata: {
        beforeState: AdminAccountStatus.PENDING_ACTIVATION,
        afterState: AdminAccountStatus.ACTIVE,
        beforeVersion: account.version,
        afterVersion: account.version + 1,
      },
      source: AdminAuditSource.HTTP,
      mongoSession: input.mongoSession,
    });
    await this.audit.record({
      action: AdminAuditAction.MFA_ENROLLED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Admin activation workflow',
      },
      target: {
        type: AdminAuditTargetType.ADMIN_ACCOUNT,
        publicId: account.publicId,
      },
      reasonCode: 'admin_mfa_enrolled_during_activation',
      metadata: {
        beforeState: AdminMfaStatus.PENDING_ENROLLMENT,
        afterState: AdminMfaStatus.ACTIVE,
      },
      source: AdminAuditSource.HTTP,
      mongoSession: input.mongoSession,
    });
    const session = await this.sessions.createSession(
      activatedAccount,
      { userAgent: input.userAgent },
      input.mongoSession,
    );
    await this.loginProtection.clearAccountFailuresInTransaction(
      input.protectionAccountKey,
      input.mongoSession,
    );
    const accessToken = await this.accessTokens.issue({
      adminPublicId: activatedAccount.publicId,
      sessionPublicId: session.sessionPublicId,
      credentialVersion: activatedAccount.credentialVersion,
      authzVersion: activatedAccount.authzVersion,
      permissionVersion: activatedAccount.permissionVersion,
    });

    return Object.freeze({
      accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      sessionPublicId: session.sessionPublicId,
      admin: Object.freeze({
        id: activatedAccount.publicId,
        publicId: activatedAccount.publicId,
        username: activatedAccount.username,
        displayName: activatedAccount.displayName,
        role: activatedAccount.role,
      }),
    });
  }

  private async loadSnapshot(
    adminPublicId: string,
    rawGrant: string,
    requirePendingMfa: boolean,
  ): Promise<ActivationSnapshot | null> {
    try {
      const account = await this.accounts
        .findOne({
          publicId: adminPublicId,
          status: AdminAccountStatus.PENDING_ACTIVATION,
          role: { $in: [AdminRole.ADMIN, AdminRole.SUPER_ADMIN] },
          mustChangePassword: true,
          lockedAt: null,
          deletedAt: null,
          activationGrantConsumedAt: null,
          activationGrantExpiresAt: { $gt: new Date() },
          ...(requirePendingMfa
            ? {
                mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
                pendingTotpEnrollmentExpiresAt: { $gt: new Date() },
              }
            : {
                mfaStatus: {
                  $in: [
                    AdminMfaStatus.NOT_ENROLLED,
                    AdminMfaStatus.PENDING_ENROLLMENT,
                  ],
                },
              }),
        })
        .select(
          '_id publicId username displayName role status mustChangePassword ' +
            'mfaStatus +credentialVersion +authzVersion +permissionVersion ' +
            '+version +activationGrantHash +activationGrantExpiresAt ' +
            '+activationGrantConsumedAt +pendingEncryptedTotpSecret ' +
            '+pendingTotpEnrollmentExpiresAt',
        )
        .lean<ActivationAccount | null>()
        .exec();
      if (!account?.activationGrantHash || !account.activationGrantExpiresAt) {
        return null;
      }

      const purpose = this.purposeFor(account.role);
      const grantHash = hashAdminActivationGrant(rawGrant, {
        purpose,
        targetPublicId: account.publicId,
        environment: this.environment(),
      });
      if (!this.hashesMatch(grantHash, account.activationGrantHash)) {
        return null;
      }

      if (purpose !== AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN) {
        return Object.freeze({ account, purpose, grantHash });
      }

      const bootstrapState = await this.bootstrapStates
        .findOne({
          key: ADMIN_BOOTSTRAP_SINGLETON_KEY,
          adminAccountId: account._id,
          adminPublicId: account.publicId,
          purpose,
          environment: this.environment(),
          grantHash,
          grantExpiresAt: account.activationGrantExpiresAt,
          consumedAt: null,
        })
        .select('+grantHash +consumedAt')
        .lean<ActivationBootstrapState | null>()
        .exec();
      return bootstrapState
        ? Object.freeze({ account, purpose, grantHash, bootstrapState })
        : null;
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private accountCasFilter(account: ActivationAccount, now: Date) {
    return {
      _id: account._id,
      publicId: account.publicId,
      role: account.role,
      status: AdminAccountStatus.PENDING_ACTIVATION,
      mustChangePassword: true,
      lockedAt: null,
      deletedAt: null,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
      version: account.version,
      activationGrantHash: account.activationGrantHash,
      activationGrantExpiresAt: { $gt: now },
      activationGrantConsumedAt: null,
    } as const;
  }

  private toChallenge(
    account: ActivationAccount,
    secret: Buffer,
    expiresAt: Date,
  ): AdminActivationChallenge {
    const secretBase32 = encodeAdminTotpSecret(secret);
    const parameters = new URLSearchParams({
      secret: secretBase32,
      issuer: ADMIN_ACTIVATION_ISSUER,
      algorithm: this.policy.mfa.algorithm,
      digits: String(this.policy.mfa.digits),
      period: String(this.policy.mfa.periodSeconds),
    });
    return Object.freeze({
      admin: Object.freeze({
        publicId: account.publicId,
        username: account.username,
        displayName: account.displayName,
      }),
      secretBase32,
      otpauthUri: `otpauth://totp/${encodeURIComponent(
        `${ADMIN_ACTIVATION_ISSUER}:${account.username}`,
      )}?${parameters.toString()}`,
      expiresAt,
    });
  }

  private protectionIdentity(input: {
    adminPublicId: string;
    trustedClientIp: string;
  }) {
    return Object.freeze({
      accountKey: `${ADMIN_ACTIVATION_ACCOUNT_KEY_PREFIX}${input.adminPublicId}`,
      trustedClientIp: input.trustedClientIp,
    });
  }

  private assertPublicInput(adminPublicId: string, rawGrant: string): void {
    if (
      !isValidAdminPublicId(adminPublicId) ||
      !isCanonicalAdminActivationGrant(rawGrant)
    ) {
      throw this.invalidActivation();
    }
  }

  private assertPassword(password: string, confirmation: string): void {
    if (password !== confirmation) {
      throw new BadRequestException(ADMIN_ACTIVATION_PASSWORD_MISMATCH_MESSAGE);
    }
    if (
      password.length < ADMIN_PASSWORD_MIN_LENGTH ||
      password.length > ADMIN_PASSWORD_MAX_LENGTH ||
      Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_UTF8_BYTES ||
      !ADMIN_PASSWORD_COMPLEXITY_PATTERN.test(password)
    ) {
      throw new BadRequestException(ADMIN_ACTIVATION_PASSWORD_POLICY_MESSAGE);
    }
  }

  private purposeFor(role: AdminRole): AdminActivationGrantPurpose {
    return role === AdminRole.SUPER_ADMIN
      ? AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN
      : AdminActivationGrantPurpose.ADMIN_ACCOUNT_ACTIVATION;
  }

  private environment(): AdminBootstrapEnvironment {
    return this.policy.environment as AdminBootstrapEnvironment;
  }

  private hashesMatch(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'ascii');
    const actualBuffer = Buffer.from(actual, 'ascii');
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  private async deny(identity: {
    accountKey: string;
    trustedClientIp: string;
  }): Promise<never> {
    await this.loginProtection.recordFailure(identity);
    throw this.invalidActivation();
  }

  private invalidActivation(): UnauthorizedException {
    return new UnauthorizedException(ADMIN_ACTIVATION_INVALID_MESSAGE);
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dich vu kich hoat Admin tam thoi khong kha dung',
      );
    }
    throw error;
  }
}
