import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ADMIN_JWT_ALGORITHM,
  ADMIN_REFRESH_TOKEN_AUDIENCE,
  ADMIN_REFRESH_TOKEN_INVALID_MESSAGE,
  ADMIN_REFRESH_TOKEN_USE,
  ADMIN_SESSION_FAMILY_PATTERN,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
  ADMIN_ACCESS_TOKEN_ISSUER,
} from '../constants/admin-auth-token.constants';
import {
  ADMIN_REFRESH_HASH_PREFIX,
  AdminSessionRevokeReason,
} from '../constants/admin-session.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { type AdminAuditActorInput } from '../interfaces/admin-audit.interface';
import {
  type AdminRefreshTokenClaims,
  type AdminSessionAccount,
  type AdminSessionCredential,
  type AdminSessionPage,
  type AdminSessionRequestMetadata,
  type AdminSessionRotationResult,
  type PublicAdminSession,
  type RevokeAdminSessionsInTransactionInput,
} from '../interfaces/admin-session.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../utils/generate-admin-session-id';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';

const JWT_HEADER_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const JWT_HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const REFRESH_CLAIM_KEYS = new Set([
  'tokenUse',
  'sub',
  'sid',
  'family',
  'version',
  'credentialVersion',
  'authzVersion',
  'permissionVersion',
  'iss',
  'aud',
  'iat',
  'exp',
]);

type UnknownRecord = Record<string, unknown>;

type StoredAdminSession = Pick<
  AdminSession,
  | 'adminAccountId'
  | 'adminPublicId'
  | 'publicId'
  | 'tokenFamily'
  | 'tokenVersion'
  | 'refreshTokenHash'
  | 'expiresAt'
  | 'revokedAt'
> & { _id: Types.ObjectId };

type ListedAdminSession = Pick<
  AdminSession,
  'publicId' | 'deviceLabel' | 'createdAt' | 'lastUsedAt' | 'expiresAt'
>;

type RefreshAdminAccount = AdminSessionAccount & {
  status: AdminAccountStatus;
  mfaStatus: AdminMfaStatus;
  mustChangePassword: boolean;
  lockedAt?: Date | null;
  deletedAt?: Date | null;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Injectable()
export class AdminSessionService {
  constructor(
    @InjectModel(AdminSession.name)
    private readonly sessionModel: Model<AdminSession>,
    @InjectModel(AdminAccount.name)
    private readonly adminAccountModel: Model<AdminAccount>,
    private readonly jwtService: JwtService,
    @Inject(ADMIN_SECRETS)
    private readonly adminSecrets: AdminSecrets,
    @Inject(ADMIN_POLICY)
    private readonly policy: AdminPolicy,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly auditService: AdminAuditService,
  ) {}

  async createSession(
    account: AdminSessionAccount,
    metadata: AdminSessionRequestMetadata,
    mongoSession: ClientSession,
  ): Promise<AdminSessionCredential> {
    this.assertAccount(account);
    this.assertActiveTransaction(mongoSession);

    const now = new Date();
    const sessionPublicId = generateAdminSessionPublicId();
    const tokenFamily = generateAdminSessionFamily();
    const expiresAt = this.addSeconds(
      now,
      this.policy.session.refreshTokenTtlSeconds,
    );
    const refreshToken = await this.issueRefreshToken({
      account,
      sessionPublicId,
      tokenFamily,
      tokenVersion: 0,
    });

    await this.sessionModel.create(
      [
        {
          adminAccountId: account._id,
          adminPublicId: account.publicId,
          publicId: sessionPublicId,
          tokenFamily,
          tokenVersion: 0,
          refreshTokenHash: this.hashRefreshToken(refreshToken),
          deviceLabel: this.createDeviceLabel(metadata.userAgent),
          lastUsedAt: now,
          expiresAt,
          revokedAt: null,
          revokeReason: null,
        },
      ],
      { session: mongoSession },
    );

    await this.auditService.record({
      action: AdminAuditAction.SESSION_CREATED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: this.toSelfAuditActor(account),
      target: {
        type: AdminAuditTargetType.ADMIN_SESSION,
        publicId: sessionPublicId,
      },
      reasonCode: 'admin_session_created',
      source: AdminAuditSource.HTTP,
      mongoSession,
    });

    return Object.freeze({ refreshToken, sessionPublicId, expiresAt });
  }

  async rotateRefreshToken(
    refreshToken: string,
  ): Promise<AdminSessionRotationResult> {
    const claims = await this.verifyRefreshToken(refreshToken);
    const now = new Date();

    let stored: StoredAdminSession | null;
    try {
      stored = await this.sessionModel
        .findOne({
          publicId: claims.sid,
          tokenFamily: claims.family,
          adminPublicId: claims.sub,
        })
        .select('+tokenFamily +tokenVersion +refreshTokenHash')
        .lean<StoredAdminSession | null>()
        .exec();
    } catch (error: unknown) {
      this.throwInfrastructure(error);
    }

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.unauthorized();
    }

    if (
      stored.tokenVersion !== claims.version ||
      !this.matchesRefreshToken(refreshToken, stored.refreshTokenHash)
    ) {
      await this.revokeForReplay(stored, now);
      throw this.unauthorized();
    }

    const account = await this.loadAccountForRefresh(stored);
    if (!account || !this.isAccountEligible(account)) {
      await this.revokeFamily(
        stored,
        AdminSessionRevokeReason.ACCOUNT_INELIGIBLE,
        AdminAuditAction.SESSION_REVOKED,
        'admin_account_ineligible',
        now,
      );
      throw this.unauthorized();
    }

    if (!this.claimVersionsMatchAccount(claims, account)) {
      await this.revokeFamily(
        stored,
        AdminSessionRevokeReason.AUTHORIZATION_CHANGED,
        AdminAuditAction.SESSION_REVOKED,
        'admin_authorization_changed',
        now,
      );
      throw this.unauthorized();
    }

    const nextVersion = claims.version + 1;
    const nextExpiresAt = this.addSeconds(
      now,
      this.policy.session.refreshTokenTtlSeconds,
    );
    const nextRefreshToken = await this.issueRefreshToken({
      account,
      sessionPublicId: stored.publicId,
      tokenFamily: stored.tokenFamily,
      tokenVersion: nextVersion,
    });
    const nextHash = this.hashRefreshToken(nextRefreshToken);

    try {
      await this.connection.transaction(async (mongoSession) => {
        const result = await this.sessionModel.updateOne(
          {
            _id: stored._id,
            adminAccountId: stored.adminAccountId,
            publicId: stored.publicId,
            tokenFamily: stored.tokenFamily,
            tokenVersion: claims.version,
            refreshTokenHash: stored.refreshTokenHash,
            revokedAt: null,
            expiresAt: { $gt: now },
          },
          {
            $set: {
              tokenVersion: nextVersion,
              refreshTokenHash: nextHash,
              lastUsedAt: now,
              expiresAt: nextExpiresAt,
            },
          },
          { session: mongoSession, runValidators: true },
        );

        if (result.modifiedCount !== 1) {
          throw this.unauthorized();
        }

        await this.auditService.record({
          action: AdminAuditAction.SESSION_ROTATED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: this.toSelfAuditActor(account),
          target: {
            type: AdminAuditTargetType.ADMIN_SESSION,
            publicId: stored.publicId,
          },
          reasonCode: 'admin_session_rotated',
          metadata: {
            beforeVersion: claims.version,
            afterVersion: nextVersion,
          },
          source: AdminAuditSource.HTTP,
          mongoSession,
        });
      });
    } catch (error: unknown) {
      this.throwTransactionError(error);
    }

    return Object.freeze({
      refreshToken: nextRefreshToken,
      sessionPublicId: stored.publicId,
      expiresAt: nextExpiresAt,
      account: Object.freeze(this.toSessionAccount(account)),
    });
  }

  async listActiveSessions(
    adminAccountId: Types.ObjectId,
    currentSessionId: string,
    page: number,
    limit: number,
  ): Promise<AdminSessionPage> {
    this.assertSessionId(currentSessionId);
    this.assertPagination(page, limit);
    const filter = {
      adminAccountId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    };

    try {
      const records = await this.sessionModel
        .find(filter)
        .sort({ lastUsedAt: -1, publicId: 1 })
        .skip((page - 1) * limit)
        .limit(limit + 1)
        .select('-_id publicId deviceLabel createdAt lastUsedAt expiresAt')
        .lean<ListedAdminSession[]>()
        .exec();
      const hasMore = records.length > limit;

      return Object.freeze({
        items: Object.freeze(
          records
            .slice(0, limit)
            .map((record) => this.toPublicSession(record, currentSessionId)),
        ),
        pagination: Object.freeze({
          page,
          limit,
          hasMore,
        }),
      });
    } catch (error: unknown) {
      this.throwInfrastructure(error);
    }
  }

  async revokeOtherSession(
    account: AdminSessionAccount,
    currentSessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    this.assertAccount(account);
    this.assertSessionId(currentSessionId);
    this.assertSessionId(targetSessionId, true);
    if (currentSessionId === targetSessionId) {
      throw new BadRequestException(
        'Hãy sử dụng chức năng đăng xuất cho phiên hiện tại',
      );
    }

    await this.runSecurityTransaction(async (mongoSession) => {
      const now = new Date();
      const result = await this.sessionModel.updateOne(
        {
          adminAccountId: account._id,
          publicId: targetSessionId,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            revokedAt: now,
            revokeReason: AdminSessionRevokeReason.SESSION_REVOKED,
          },
        },
        { session: mongoSession, runValidators: true },
      );

      if (result.modifiedCount !== 1) {
        throw new NotFoundException('Không tìm thấy phiên quản trị');
      }

      await this.auditSessionRevocation(
        this.toSelfAuditActor(account),
        targetSessionId,
        'admin_session_revoke_requested',
        mongoSession,
      );
    });
  }

  async logoutAllSelf(account: AdminSessionAccount): Promise<number> {
    this.assertAccount(account);
    return this.runSecurityTransaction((mongoSession) =>
      this.revokeAllInTransaction({
        targetAdminAccountId: account._id,
        targetAdminPublicId: account.publicId,
        reason: AdminSessionRevokeReason.LOGOUT_ALL,
        auditActor: this.toSelfAuditActor(account),
        mongoSession,
      }),
    );
  }

  async revokeAllInTransaction(
    input: RevokeAdminSessionsInTransactionInput,
  ): Promise<number> {
    this.assertActiveTransaction(input.mongoSession);
    if (
      !Types.ObjectId.isValid(input.targetAdminAccountId) ||
      !isValidAdminPublicId(input.targetAdminPublicId)
    ) {
      throw new TypeError('Admin revoke-all target không hợp lệ');
    }

    const now = new Date();
    const result = await this.sessionModel.updateMany(
      {
        adminAccountId: input.targetAdminAccountId,
        adminPublicId: input.targetAdminPublicId,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: { revokedAt: now, revokeReason: input.reason },
      },
      { session: input.mongoSession, runValidators: true },
    );

    if (result.modifiedCount > 0) {
      await this.auditService.record({
        action: AdminAuditAction.SESSIONS_REVOKED_ALL,
        outcome: AdminAuditOutcome.SUCCEEDED,
        actor: input.auditActor,
        target: {
          type: AdminAuditTargetType.ADMIN_ACCOUNT,
          publicId: input.targetAdminPublicId,
        },
        reasonCode: input.reason,
        metadata: { affectedSessionCount: result.modifiedCount },
        source: AdminAuditSource.HTTP,
        mongoSession: input.mongoSession,
      });
    }

    return result.modifiedCount;
  }

  async isSessionActive(
    adminAccountId: Types.ObjectId,
    sessionPublicId: string,
  ): Promise<boolean> {
    if (!ADMIN_SESSION_PUBLIC_ID_PATTERN.test(sessionPublicId)) return false;
    try {
      return Boolean(
        await this.sessionModel
          .exists({
            adminAccountId,
            publicId: sessionPublicId,
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          })
          .exec(),
      );
    } catch (error: unknown) {
      this.throwInfrastructure(error);
    }
  }

  private async loadAccountForRefresh(
    stored: StoredAdminSession,
  ): Promise<RefreshAdminAccount | null> {
    try {
      return await this.adminAccountModel
        .findOne({
          _id: stored.adminAccountId,
          publicId: stored.adminPublicId,
        })
        .select(
          '_id publicId username displayName role status mfaStatus ' +
            'mustChangePassword lockedAt deletedAt +credentialVersion ' +
            '+authzVersion +permissionVersion',
        )
        .lean<RefreshAdminAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.throwInfrastructure(error);
    }
  }

  private isAccountEligible(account: RefreshAdminAccount): boolean {
    return (
      account.status === AdminAccountStatus.ACTIVE &&
      account.mfaStatus === AdminMfaStatus.ACTIVE &&
      account.mustChangePassword === false &&
      !account.lockedAt &&
      !account.deletedAt
    );
  }

  private claimVersionsMatchAccount(
    claims: AdminRefreshTokenClaims,
    account: AdminSessionAccount,
  ): boolean {
    return (
      claims.credentialVersion === account.credentialVersion &&
      claims.authzVersion === account.authzVersion &&
      claims.permissionVersion === account.permissionVersion
    );
  }

  private async revokeForReplay(
    stored: StoredAdminSession,
    now: Date,
  ): Promise<void> {
    await this.revokeFamily(
      stored,
      AdminSessionRevokeReason.REFRESH_REPLAY,
      AdminAuditAction.REFRESH_REPLAY_DETECTED,
      'admin_refresh_replay_detected',
      now,
    );
  }

  private async revokeFamily(
    stored: StoredAdminSession,
    revokeReason: AdminSessionRevokeReason,
    action: AdminAuditAction,
    auditReasonCode: string,
    now: Date,
  ): Promise<void> {
    await this.runSecurityTransaction(async (mongoSession) => {
      const result = await this.sessionModel.updateOne(
        {
          _id: stored._id,
          adminAccountId: stored.adminAccountId,
          publicId: stored.publicId,
          tokenFamily: stored.tokenFamily,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        { $set: { revokedAt: now, revokeReason } },
        { session: mongoSession, runValidators: true },
      );

      if (result.modifiedCount !== 1) return;

      await this.auditService.record({
        action,
        outcome:
          action === AdminAuditAction.REFRESH_REPLAY_DETECTED
            ? AdminAuditOutcome.DENIED
            : AdminAuditOutcome.SUCCEEDED,
        actor: {
          type: AdminAuditActorType.SYSTEM,
          displayName: 'Admin session security',
        },
        target: {
          type: AdminAuditTargetType.ADMIN_SESSION,
          publicId: stored.publicId,
        },
        reasonCode: auditReasonCode,
        source: AdminAuditSource.SYSTEM,
        mongoSession,
      });
    });
  }

  private async auditSessionRevocation(
    actor: AdminAuditActorInput,
    targetSessionId: string,
    reasonCode: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    await this.auditService.record({
      action: AdminAuditAction.SESSION_REVOKED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor,
      target: {
        type: AdminAuditTargetType.ADMIN_SESSION,
        publicId: targetSessionId,
      },
      reasonCode,
      source: AdminAuditSource.HTTP,
      mongoSession,
    });
  }

  private async issueRefreshToken(input: {
    account: AdminSessionAccount;
    sessionPublicId: string;
    tokenFamily: string;
    tokenVersion: number;
  }): Promise<string> {
    const key = this.adminSecrets.current(
      AdminSecretPurpose.REFRESH_TOKEN_SIGNING,
    );
    return this.jwtService.signAsync(
      {
        tokenUse: ADMIN_REFRESH_TOKEN_USE,
        sid: input.sessionPublicId,
        family: input.tokenFamily,
        version: input.tokenVersion,
        credentialVersion: input.account.credentialVersion,
        authzVersion: input.account.authzVersion,
        permissionVersion: input.account.permissionVersion,
      },
      {
        secret: key.key,
        algorithm: ADMIN_JWT_ALGORITHM,
        keyid: key.id,
        issuer: ADMIN_ACCESS_TOKEN_ISSUER,
        audience: ADMIN_REFRESH_TOKEN_AUDIENCE,
        subject: input.account.publicId,
        expiresIn: this.policy.session.refreshTokenTtlSeconds,
      },
    );
  }

  private async verifyRefreshToken(
    token: string,
  ): Promise<AdminRefreshTokenClaims> {
    try {
      const keyId = this.readRefreshTokenKeyId(token);
      const key = this.adminSecrets.resolve(
        AdminSecretPurpose.REFRESH_TOKEN_SIGNING,
        keyId,
      );
      const claims = await this.jwtService.verifyAsync<UnknownRecord>(token, {
        secret: key.key,
        algorithms: [ADMIN_JWT_ALGORITHM],
        issuer: ADMIN_ACCESS_TOKEN_ISSUER,
        audience: ADMIN_REFRESH_TOKEN_AUDIENCE,
        clockTolerance: ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
      });
      if (!this.isValidRefreshClaims(claims)) throw new Error('claims');
      return claims;
    } catch {
      throw this.unauthorized();
    }
  }

  private readRefreshTokenKeyId(token: string): string {
    const segments = token.split('.');
    const encodedHeader = segments[0];
    if (
      segments.length !== 3 ||
      !encodedHeader ||
      !JWT_HEADER_SEGMENT_PATTERN.test(encodedHeader)
    ) {
      throw new Error('header');
    }
    const decoded = Buffer.from(encodedHeader, 'base64url');
    if (decoded.toString('base64url') !== encodedHeader) {
      throw new Error('header');
    }
    const header: unknown = JSON.parse(decoded.toString('utf8'));
    if (
      !isRecord(header) ||
      !hasOnlyKeys(header, JWT_HEADER_KEYS) ||
      header.alg !== ADMIN_JWT_ALGORITHM ||
      header.typ !== 'JWT' ||
      typeof header.kid !== 'string'
    ) {
      throw new Error('header');
    }
    return header.kid;
  }

  private isValidRefreshClaims(
    value: unknown,
  ): value is AdminRefreshTokenClaims {
    if (!isRecord(value) || !hasOnlyKeys(value, REFRESH_CLAIM_KEYS)) {
      return false;
    }
    if (
      value.tokenUse !== ADMIN_REFRESH_TOKEN_USE ||
      !isValidAdminPublicId(value.sub) ||
      typeof value.sid !== 'string' ||
      !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(value.sid) ||
      typeof value.family !== 'string' ||
      !ADMIN_SESSION_FAMILY_PATTERN.test(value.family) ||
      !isNonNegativeInteger(value.version) ||
      !isNonNegativeInteger(value.credentialVersion) ||
      !isNonNegativeInteger(value.authzVersion) ||
      !isNonNegativeInteger(value.permissionVersion) ||
      value.iss !== ADMIN_ACCESS_TOKEN_ISSUER ||
      value.aud !== ADMIN_REFRESH_TOKEN_AUDIENCE ||
      !isNonNegativeInteger(value.iat) ||
      !isNonNegativeInteger(value.exp)
    ) {
      return false;
    }
    const lifetime = value.exp - value.iat;
    const now = Math.floor(Date.now() / 1000);
    return (
      value.iat <= now + ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS &&
      lifetime > 0 &&
      lifetime <= this.policy.session.refreshTokenTtlSeconds
    );
  }

  private hashRefreshToken(token: string): string {
    return (
      ADMIN_REFRESH_HASH_PREFIX +
      createHash('sha256').update(token, 'utf8').digest('hex')
    );
  }

  private matchesRefreshToken(token: string, storedHash: string): boolean {
    if (!storedHash.startsWith(ADMIN_REFRESH_HASH_PREFIX)) return false;
    const expected = Buffer.from(
      storedHash.slice(ADMIN_REFRESH_HASH_PREFIX.length),
      'hex',
    );
    const actual = Buffer.from(
      this.hashRefreshToken(token).slice(ADMIN_REFRESH_HASH_PREFIX.length),
      'hex',
    );
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private toSelfAuditActor(account: AdminSessionAccount): AdminAuditActorInput {
    return {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      permissionVersion: account.permissionVersion,
    };
  }

  private toSessionAccount(account: RefreshAdminAccount): AdminSessionAccount {
    return {
      _id: account._id,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    };
  }

  private toPublicSession(
    record: ListedAdminSession,
    currentSessionId: string,
  ): PublicAdminSession {
    return Object.freeze({
      id: record.publicId,
      deviceLabel: record.deviceLabel,
      createdAt: record.createdAt.toISOString(),
      lastUsedAt: record.lastUsedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      isCurrent: record.publicId === currentSessionId,
    });
  }

  private createDeviceLabel(userAgent?: string): string {
    if (!userAgent?.trim()) return 'Thiết bị không xác định';
    const normalized = userAgent.slice(0, 512).toLowerCase();
    const browser = normalized.includes('edg/')
      ? 'Edge'
      : normalized.includes('firefox/')
        ? 'Firefox'
        : normalized.includes('chrome/')
          ? 'Chrome'
          : normalized.includes('safari/')
            ? 'Safari'
            : 'Trình duyệt';
    const os =
      normalized.includes('iphone') || normalized.includes('ipad')
        ? 'iOS'
        : normalized.includes('android')
          ? 'Android'
          : normalized.includes('windows')
            ? 'Windows'
            : normalized.includes('mac os')
              ? 'macOS'
              : normalized.includes('linux')
                ? 'Linux'
                : 'thiết bị không xác định';
    return `${browser} trên ${os}`.slice(0, 80);
  }

  private assertAccount(account: AdminSessionAccount): void {
    if (
      !(account._id instanceof Types.ObjectId) ||
      !isValidAdminPublicId(account.publicId) ||
      !account.username.trim() ||
      !account.displayName.trim() ||
      (account.role !== AdminRole.ADMIN &&
        account.role !== AdminRole.SUPER_ADMIN) ||
      !isNonNegativeInteger(account.credentialVersion) ||
      !isNonNegativeInteger(account.authzVersion) ||
      !isNonNegativeInteger(account.permissionVersion)
    ) {
      throw new TypeError('Admin session account không hợp lệ');
    }
  }

  private assertActiveTransaction(session: ClientSession): void {
    if (session?.inTransaction() !== true) {
      throw new TypeError('Admin session mutation yêu cầu transaction active');
    }
  }

  private assertSessionId(value: string, asNotFound = false): void {
    if (ADMIN_SESSION_PUBLIC_ID_PATTERN.test(value)) return;
    if (asNotFound)
      throw new NotFoundException('Không tìm thấy phiên quản trị');
    throw this.unauthorized();
  }

  private assertPagination(page: number, limit: number): void {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.policy.pagination.maximumLimit
    ) {
      throw new TypeError('Admin session pagination không hợp lệ');
    }
  }

  private async runSecurityTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.connection.transaction(operation);
    } catch (error: unknown) {
      this.throwTransactionError(error);
    }
  }

  private throwTransactionError(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Không thể hoàn tất thao tác phiên quản trị',
      );
    }
    throw error;
  }

  private throwInfrastructure(error: unknown): never {
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Không thể truy cập phiên quản trị',
      );
    }
    throw error;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException(ADMIN_REFRESH_TOKEN_INVALID_MESSAGE);
  }

  private addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
  }
}
