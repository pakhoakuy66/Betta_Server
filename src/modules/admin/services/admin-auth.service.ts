import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AdminAccountStatus,
  AdminMfaStatus,
} from '../constants/admin-account.constants';
import {
  ADMIN_AUTH_MAX_PASSWORD_LENGTH,
  ADMIN_AUTH_MAX_REFRESH_TOKEN_LENGTH,
  ADMIN_AUTH_UNAVAILABLE_MESSAGE,
  ADMIN_INVALID_CREDENTIALS_MESSAGE,
  ADMIN_LOGIN_SECURITY_CONTROL_PUBLIC_ID,
} from '../constants/admin-auth.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  type AdminAuthenticationResult,
  type AdminLoginInput,
  type PublicAuthenticatedAdmin,
} from '../interfaces/admin-auth.interface';
import { type AdminSessionAccount } from '../interfaces/admin-session.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminAccessTokenService } from './admin-access-token.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminLoginProtectionService } from './admin-login-protection.service';
import { AdminMfaService } from './admin-mfa.service';
import { AdminSessionService } from './admin-session.service';

const DUMMY_PASSWORD_HASH =
  '$2b$12$CwTycUXWue0Thq9StjUM0uJ8xgOguJdyQh7fXxH4ILhYo8sHpItCu';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOTP_PATTERN = /^\d{6}$/;

type LoginAccount = Pick<
  AdminAccount,
  | 'publicId'
  | 'username'
  | 'displayName'
  | 'role'
  | 'status'
  | 'mfaStatus'
  | 'mustChangePassword'
  | 'lockedAt'
  | 'deletedAt'
  | 'passwordHash'
  | 'credentialVersion'
  | 'authzVersion'
  | 'permissionVersion'
> & { _id: Types.ObjectId };

type AuthenticatedLogin = Readonly<{
  account: AdminSessionAccount;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionPublicId: string;
}>;

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accountModel: Model<AdminAccount>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly loginProtection: AdminLoginProtectionService,
    private readonly mfa: AdminMfaService,
    private readonly sessions: AdminSessionService,
    private readonly accessTokens: AdminAccessTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  async login(input: AdminLoginInput): Promise<AdminAuthenticationResult> {
    const email = this.normalizeLoginInput(input);
    const identity = {
      accountKey: email,
      trustedClientIp: input.trustedClientIp,
    } as const;

    await this.loginProtection.assertAllowed(identity);

    const account = await this.loadLoginAccount(email);
    const passwordHash = account?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(input.password, passwordHash);

    if (!account || !account.passwordHash || !passwordMatches) {
      return this.denyLogin(identity, account);
    }

    if (!this.isEligible(account)) {
      return this.denyLogin(identity, account);
    }

    try {
      const authenticated = await this.connection.transaction(
        async (mongoSession) =>
          this.completeLoginTransaction(
            account,
            input.totpToken,
            input.userAgent,
            email,
            mongoSession,
          ),
      );

      return Object.freeze({
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        refreshTokenExpiresAt: authenticated.refreshTokenExpiresAt,
        sessionPublicId: authenticated.sessionPublicId,
        admin: this.toPublicAdmin(authenticated.account),
      });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        await this.denyLogin(identity, account);
      }
      this.rethrow(error);
    }
  }

  async refresh(refreshToken: string): Promise<AdminAuthenticationResult> {
    this.assertRefreshToken(refreshToken);
    const rotated = await this.sessions.rotateRefreshToken(refreshToken);
    const accessToken = await this.accessTokens.issue({
      adminPublicId: rotated.account.publicId,
      sessionPublicId: rotated.sessionPublicId,
      credentialVersion: rotated.account.credentialVersion,
      authzVersion: rotated.account.authzVersion,
      permissionVersion: rotated.account.permissionVersion,
    });

    return Object.freeze({
      accessToken,
      refreshToken: rotated.refreshToken,
      refreshTokenExpiresAt: rotated.expiresAt,
      sessionPublicId: rotated.sessionPublicId,
      admin: this.toPublicAdmin(rotated.account),
    });
  }

  async logout(
    account: AdminSessionAccount,
    sessionPublicId: string,
  ): Promise<boolean> {
    return this.sessions.revokeCurrentSession(account, sessionPublicId);
  }

  private async completeLoginTransaction(
    expected: LoginAccount,
    totpToken: string,
    userAgent: string | undefined,
    email: string,
    mongoSession: ClientSession,
  ): Promise<AuthenticatedLogin> {
    const account = await this.accountModel
      .findOne({
        _id: expected._id,
        publicId: expected.publicId,
        passwordHash: expected.passwordHash,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        lockedAt: null,
        deletedAt: null,
      })
      .select(
        '_id publicId username displayName role +credentialVersion ' +
          '+authzVersion +permissionVersion',
      )
      .session(mongoSession)
      .lean<AdminSessionAccount | null>()
      .exec();

    if (!account) throw this.invalidCredentials();

    const mfaValid = await this.mfa.verifyTotpInTransaction(
      account._id,
      account.publicId,
      totpToken,
      mongoSession,
    );
    if (!mfaValid) throw this.invalidCredentials();

    await this.loginProtection.clearAccountFailuresInTransaction(
      email,
      mongoSession,
    );
    const session = await this.sessions.createSession(
      account,
      { userAgent },
      mongoSession,
    );
    const accessToken = await this.accessTokens.issue({
      adminPublicId: account.publicId,
      sessionPublicId: session.sessionPublicId,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    });

    await this.audit.record({
      action: AdminAuditAction.LOGIN_SUCCEEDED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: this.toAuditActor(account),
      target: {
        type: AdminAuditTargetType.ADMIN_ACCOUNT,
        publicId: account.publicId,
      },
      reasonCode: 'admin_login_succeeded',
      source: AdminAuditSource.HTTP,
      mongoSession,
    });

    return Object.freeze({
      account,
      accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      sessionPublicId: session.sessionPublicId,
    });
  }

  private async loadLoginAccount(email: string): Promise<LoginAccount | null> {
    try {
      return await this.accountModel
        .findOne({ email })
        .select(
          '_id publicId username displayName role status mfaStatus ' +
            'mustChangePassword lockedAt deletedAt +passwordHash ' +
            '+credentialVersion +authzVersion +permissionVersion',
        )
        .lean<LoginAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async denyLogin(
    identity: Readonly<{ accountKey: string; trustedClientIp: string }>,
    account: LoginAccount | null,
  ): Promise<never> {
    let protectionError: unknown;
    try {
      await this.loginProtection.recordFailure(identity);
    } catch (error: unknown) {
      protectionError = error;
    }

    await this.audit.record({
      action: account
        ? AdminAuditAction.LOGIN_DENIED
        : AdminAuditAction.SECURITY_REQUEST_DENIED,
      outcome: AdminAuditOutcome.DENIED,
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Admin authentication',
      },
      target: account
        ? {
            type: AdminAuditTargetType.ADMIN_ACCOUNT,
            publicId: account.publicId,
          }
        : {
            type: AdminAuditTargetType.SECURITY_CONTROL,
            publicId: ADMIN_LOGIN_SECURITY_CONTROL_PUBLIC_ID,
          },
      reasonCode: 'admin_login_denied',
      source: AdminAuditSource.HTTP,
    });

    if (protectionError) this.rethrow(protectionError);
    throw this.invalidCredentials();
  }

  private normalizeLoginInput(input: AdminLoginInput): string {
    const email = normalizeAuthEmail(input.email);
    if (
      email.length > 254 ||
      !EMAIL_PATTERN.test(email) ||
      typeof input.password !== 'string' ||
      input.password.length < 1 ||
      input.password.length > ADMIN_AUTH_MAX_PASSWORD_LENGTH ||
      !TOTP_PATTERN.test(input.totpToken) ||
      typeof input.trustedClientIp !== 'string' ||
      input.trustedClientIp.length < 1 ||
      input.trustedClientIp.length > 128 ||
      (input.userAgent !== undefined &&
        (typeof input.userAgent !== 'string' || input.userAgent.length > 2_048))
    ) {
      throw new TypeError('Admin login input khong hop le');
    }
    return email;
  }

  private assertRefreshToken(value: string): void {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > ADMIN_AUTH_MAX_REFRESH_TOKEN_LENGTH
    ) {
      throw this.invalidCredentials();
    }
  }

  private isEligible(account: LoginAccount): boolean {
    return (
      account.status === AdminAccountStatus.ACTIVE &&
      account.mfaStatus === AdminMfaStatus.ACTIVE &&
      account.mustChangePassword === false &&
      !account.lockedAt &&
      !account.deletedAt
    );
  }

  private toAuditActor(account: AdminSessionAccount) {
    return {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      permissionVersion: account.permissionVersion,
    } as const;
  }

  private toPublicAdmin(
    account: AdminSessionAccount,
  ): PublicAuthenticatedAdmin {
    return Object.freeze({
      id: account.publicId,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
    });
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException(ADMIN_INVALID_CREDENTIALS_MESSAGE);
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(ADMIN_AUTH_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}
