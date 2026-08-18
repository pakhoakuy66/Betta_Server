import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { type ClientSession, Model, Types, Connection } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AuthAuditService } from './auth-audit.service';
import { User } from '../../users/schemas/user.schema';
import {
  AuthSession,
  SessionRevokeReason,
} from '../schemas/auth-session.schema';
import {
  type AccessTokenPayload,
  type AuthSessionPage,
  type PublicAuthSession,
  type RefreshTokenPayload,
  type SessionRequestMetadata,
} from '../interfaces/auth-session.interface';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
  REFRESH_TOKEN_AUDIENCE,
} from '../constants/auth-token.constants';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { AccountRestrictedException } from '../exceptions/account-restricted.exception';
import { isActiveUserRestriction } from '../../users/utils/user-restriction';

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_HASH_ROUNDS = 10;

const REFRESH_HASH_PREFIX = 'sha256-bcrypt-v1:';
const ACTIVE_USER_STATUS = 'active';

const INVALID_REFRESH_MESSAGE = 'Refresh token không hợp lệ hoặc đã bị thu hồi';

export type AuthTokenPair = {
  access_token: string;
  refresh_token: string;
};

type SessionUser = Pick<User, '_id' | 'email' | 'username' | 'authzVersion'>;
type ActiveSessionRecord = Pick<
  AuthSession,
  'publicId' | 'deviceLabel' | 'createdAt' | 'lastUsedAt' | 'expiresAt'
>;

@Injectable()
export class AuthSessionService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly refreshHashRounds: number;

  constructor(
    @InjectModel(AuthSession.name)
    private readonly sessionModel: Model<AuthSession>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly jwtService: JwtService,
    configService: ConfigService,

    @InjectConnection()
    private readonly connection: Connection,

    private readonly authAuditService: AuthAuditService,
  ) {
    this.accessSecret = this.readSecret(configService, 'JWT_SECRET');
    this.refreshSecret = this.readSecret(configService, 'JWT_REFRESH_SECRET');

    if (this.accessSecret === this.refreshSecret) {
      throw new Error('JWT_SECRET và JWT_REFRESH_SECRET không được giống nhau');
    }

    this.accessTtlSeconds = this.readInteger(
      configService,
      'JWT_ACCESS_TTL_SECONDS',
      DEFAULT_ACCESS_TTL_SECONDS,
      60,
      3600,
    );

    this.refreshTtlSeconds = this.readInteger(
      configService,
      'JWT_REFRESH_TTL_SECONDS',
      DEFAULT_REFRESH_TTL_SECONDS,
      3600,
      30 * 24 * 60 * 60,
    );

    this.refreshHashRounds = this.readInteger(
      configService,
      'REFRESH_TOKEN_HASH_ROUNDS',
      DEFAULT_REFRESH_HASH_ROUNDS,
      8,
      14,
    );
  }

  async createSession(
    user: SessionUser,
    metadata: SessionRequestMetadata,
    mongoSession?: ClientSession,
  ): Promise<AuthTokenPair> {
    if (!Number.isSafeInteger(user.authzVersion) || user.authzVersion < 0) {
      throw new TypeError('User authzVersion không hợp lệ');
    }
    const now = new Date();
    const sessionId = `ses_${randomUUID()}`;
    const tokenFamily = randomUUID();

    const refreshPayload: RefreshTokenPayload = {
      tokenUse: 'refresh',
      sub: String(user._id),
      sid: sessionId,
      family: tokenFamily,
      version: 0,
    };

    const accessToken = this.signAccessToken(user, sessionId);

    const refreshToken = this.signRefreshToken(refreshPayload);

    const refreshTokenHash = await this.hashRefreshToken(refreshToken);

    const document = {
      userId: new Types.ObjectId(String(user._id)),
      publicId: sessionId,
      tokenFamily,
      tokenVersion: 0,
      refreshTokenHash,
      deviceLabel: this.createDeviceLabel(metadata.userAgent),
      lastUsedAt: now,
      expiresAt: this.addSeconds(now, this.refreshTtlSeconds),
      revokedAt: null,
      revokeReason: null,
    };

    if (mongoSession) {
      await this.sessionModel.create([document], { session: mongoSession });
    } else {
      await this.sessionModel.create(document);
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  async rotateRefreshToken(refreshToken: string): Promise<AuthTokenPair> {
    const payload = this.verifyRefreshToken(refreshToken);
    this.assertRefreshPayload(payload);

    const now = new Date();
    const userId = new Types.ObjectId(payload.sub);

    const session = await this.sessionModel
      .findOne({
        userId,
        publicId: payload.sid,
        tokenFamily: payload.family,
      })
      .select('+refreshTokenHash')
      .exec();

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    if (session.tokenVersion !== payload.version) {
      await this.revokeSessionForRefreshReplay(
        userId,
        session.publicId,
        session.tokenFamily,
        now,
      );

      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    const tokenMatched = await this.isRefreshTokenMatched(
      refreshToken,
      session.refreshTokenHash,
    );

    if (!tokenMatched) {
      await this.revokeSessionForRefreshReplay(
        userId,
        session.publicId,
        session.tokenFamily,
        now,
      );

      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    const user = await this.userModel
      .findById(userId)
      .select('_id email username status isDeleted +authzVersion +restriction')
      .exec();

    if (!user || user.isDeleted) {
      await this.revokeSession(
        session.publicId,
        session.tokenFamily,
        SessionRevokeReason.ACCOUNT_DELETED,
        now,
      );

      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    if (isActiveUserRestriction(user.restriction, now)) {
      await this.revokeSession(
        session.publicId,
        session.tokenFamily,
        SessionRevokeReason.ACCOUNT_RESTRICTED,
        now,
      );
      throw new AccountRestrictedException(user.restriction);
    }

    if (user.status !== ACTIVE_USER_STATUS) {
      await this.revokeSession(
        session.publicId,
        session.tokenFamily,
        SessionRevokeReason.ACCOUNT_BLOCKED,
        now,
      );

      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    const nextVersion = payload.version + 1;

    // Không kế thừa iat, exp, iss hoặc aud từ JWT đã verify.
    const nextPayload: RefreshTokenPayload = {
      tokenUse: 'refresh',
      sub: payload.sub,
      sid: payload.sid,
      family: payload.family,
      version: nextVersion,
    };

    // Không còn crypto failure point sau khi CAS đã commit.
    const nextAccessToken = this.signAccessToken(user, payload.sid);
    const nextRefreshToken = this.signRefreshToken(nextPayload);
    const nextRefreshHash = await this.hashRefreshToken(nextRefreshToken);
    const nextExpiry = this.addSeconds(now, this.refreshTtlSeconds);

    const rotatedSession = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: session._id,
          userId,
          publicId: payload.sid,
          tokenFamily: payload.family,
          tokenVersion: payload.version,
          refreshTokenHash: session.refreshTokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            tokenVersion: nextVersion,
            refreshTokenHash: nextRefreshHash,
            lastUsedAt: now,
            expiresAt: nextExpiry,
          },
        },
        {
          returnDocument: 'after',
          runValidators: true,
        },
      )
      .exec();

    if (!rotatedSession) {
      /*
       * Một request khác có thể đã rotate thành công.
       * CAS loser nhận 401 nhưng không revoke phiên thắng.
       */
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    return {
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
    };
  }

  async revokeCurrentSession(
    userId: Types.ObjectId,
    sessionId: string,
  ): Promise<void> {
    if (!this.isValidSessionId(sessionId)) return;

    await this.sessionModel.updateOne(
      {
        userId,
        publicId: sessionId,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date(),
          revokeReason: SessionRevokeReason.LOGOUT,
        },
      },
    );
  }

  async revokeAllSessions(
    userId: Types.ObjectId,
    reason: SessionRevokeReason,
    mongoSession?: ClientSession,
  ): Promise<number> {
    const filter = {
      userId,
      revokedAt: null,
    };

    const update = {
      $set: {
        revokedAt: new Date(),
        revokeReason: reason,
      },
    };

    const result = mongoSession
      ? await this.sessionModel.updateMany(filter, update, {
          session: mongoSession,
        })
      : await this.sessionModel.updateMany(filter, update);

    return result.modifiedCount;
  }

  async listActiveSessions(
    userId: string,
    currentSessionId: string,
    page: number,
    limit: number,
  ): Promise<AuthSessionPage> {
    const userObjectId = this.parseUserId(userId);

    if (!this.isValidSessionId(currentSessionId)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    const now = new Date();
    const filter = {
      userId: userObjectId,
      revokedAt: null,
      expiresAt: { $gt: now },
    };

    const projection =
      '-_id publicId deviceLabel createdAt lastUsedAt expiresAt';

    const [currentSession, total] = await Promise.all([
      this.sessionModel
        .findOne({
          ...filter,
          publicId: currentSessionId,
        })
        .select(projection)
        .lean<ActiveSessionRecord | null>()
        .exec(),

      this.sessionModel.countDocuments(filter).exec(),
    ]);

    const currentOffset = currentSession ? 1 : 0;

    const skip = Math.max(0, (page - 1) * limit - currentOffset);

    const otherLimit = page === 1 && currentSession ? limit - 1 : limit;

    const otherSessions =
      otherLimit === 0
        ? []
        : await this.sessionModel
            .find({
              ...filter,
              publicId: { $ne: currentSessionId },
            })
            .sort({
              lastUsedAt: -1,
              publicId: 1,
            })
            .skip(skip)
            .limit(otherLimit)
            .select(projection)
            .lean<ActiveSessionRecord[]>()
            .exec();

    const items: PublicAuthSession[] = [
      ...(page === 1 && currentSession
        ? [this.toPublicSession(currentSession, currentSessionId)]
        : []),
      ...otherSessions.map((session) =>
        this.toPublicSession(session, currentSessionId),
      ),
    ];

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async revokeOtherSession(
    userId: string,
    targetSessionId: string,
    currentSessionId: string,
  ): Promise<void> {
    const userObjectId = this.parseUserId(userId);

    if (!this.isValidSessionId(currentSessionId)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    if (!this.isValidSessionId(targetSessionId)) {
      throw new NotFoundException('Không tìm thấy phiên đăng nhập');
    }

    if (targetSessionId === currentSessionId) {
      throw new BadRequestException(
        'Hãy sử dụng chức năng đăng xuất để đóng phiên hiện tại',
      );
    }

    await this.runSessionSecurityTransaction(async (mongoSession) => {
      const now = new Date();

      const result = await this.sessionModel.updateOne(
        {
          userId: userObjectId,
          publicId: targetSessionId,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            revokedAt: now,
            revokeReason: SessionRevokeReason.SESSION_REVOKED,
          },
        },
        {
          session: mongoSession,
        },
      );

      if (result.modifiedCount !== 1) {
        throw new NotFoundException('Không tìm thấy phiên đăng nhập');
      }

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
        targetUserId: userObjectId,
        actorUserId: userObjectId,
        sessionPublicId: targetSessionId,
        mongoSession,
      });
    });
  }

  async logoutAllSessions(userId: string): Promise<number> {
    const userObjectId = this.parseUserId(userId);

    return this.runSessionSecurityTransaction(async (mongoSession) => {
      const affectedSessionCount = await this.revokeActiveSessionsForLogoutAll(
        userObjectId,
        mongoSession,
      );

      if (affectedSessionCount === 0) {
        return 0;
      }

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.LOGOUT_ALL_REQUESTED,
        targetUserId: userObjectId,
        actorUserId: userObjectId,
        metadata: {
          affectedSessionCount,
        },
        mongoSession,
      });

      return affectedSessionCount;
    });
  }

  async isSessionActive(
    userId: Types.ObjectId,
    sessionId: string,
  ): Promise<boolean> {
    if (!this.isValidSessionId(sessionId)) return false;

    const result = await this.sessionModel
      .exists({
        userId,
        publicId: sessionId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })
      .exec();

    return Boolean(result);
  }

  private async runSessionSecurityTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.connection.transaction(operation);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể hoàn tất thao tác bảo mật',
        );
      }

      throw error;
    }
  }

  private async revokeActiveSessionsForLogoutAll(
    userId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<number> {
    const now = new Date();

    const result = await this.sessionModel.updateMany(
      {
        userId,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          revokedAt: now,
          revokeReason: SessionRevokeReason.LOGOUT_ALL,
        },
      },
      {
        session: mongoSession,
      },
    );

    return result.modifiedCount;
  }

  private verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      return this.jwtService.verify<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
        issuer: AUTH_JWT_ISSUER,
        audience: REFRESH_TOKEN_AUDIENCE,
        algorithms: [AUTH_JWT_ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
  }

  private signAccessToken(user: SessionUser, sessionId: string): string {
    const payload: AccessTokenPayload = {
      tokenUse: 'access',
      sub: String(user._id),
      sid: sessionId,
      email: user.email,
      username: user.username,
      authzVersion: user.authzVersion,
    };

    return this.jwtService.sign(payload, {
      secret: this.accessSecret,
      issuer: AUTH_JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithm: AUTH_JWT_ALGORITHM,
      expiresIn: this.accessTtlSeconds,
    });
  }

  private signRefreshToken(payload: RefreshTokenPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.refreshSecret,
      issuer: AUTH_JWT_ISSUER,
      audience: REFRESH_TOKEN_AUDIENCE,
      algorithm: AUTH_JWT_ALGORITHM,
      expiresIn: this.refreshTtlSeconds,
    });
  }

  private digestRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url');
  }

  private async hashRefreshToken(token: string): Promise<string> {
    const digest = this.digestRefreshToken(token);
    const hash = await bcrypt.hash(digest, this.refreshHashRounds);

    return `${REFRESH_HASH_PREFIX}${hash}`;
  }

  private async isRefreshTokenMatched(
    token: string,
    storedHash: string,
  ): Promise<boolean> {
    if (!storedHash.startsWith(REFRESH_HASH_PREFIX)) {
      return false;
    }

    const bcryptHash = storedHash.slice(REFRESH_HASH_PREFIX.length);

    if (!bcryptHash) return false;

    return bcrypt.compare(this.digestRefreshToken(token), bcryptHash);
  }

  private assertRefreshPayload(payload: RefreshTokenPayload): void {
    if (
      payload.tokenUse !== 'refresh' ||
      !Types.ObjectId.isValid(payload.sub) ||
      !this.isValidSessionId(payload.sid) ||
      typeof payload.family !== 'string' ||
      payload.family.length < 20 ||
      payload.family.length > 64 ||
      !Number.isInteger(payload.version) ||
      payload.version < 0
    ) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
  }

  private async revokeSessionForRefreshReplay(
    userId: Types.ObjectId,
    sessionId: string,
    tokenFamily: string,
    now: Date,
  ): Promise<boolean> {
    return this.runSessionSecurityTransaction(async (mongoSession) => {
      const result = await this.sessionModel.updateOne(
        {
          userId,
          publicId: sessionId,
          tokenFamily,
          revokedAt: null,
          expiresAt: {
            $gt: now,
          },
        },
        {
          $set: {
            revokedAt: now,
            revokeReason: SessionRevokeReason.REFRESH_REPLAY,
          },
        },
        {
          session: mongoSession,
        },
      );

      if (result.modifiedCount !== 1) {
        return false;
      }

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
        outcome: AuthAuditOutcome.DENIED,
        reasonCode: AuthAuditReasonCode.REFRESH_TOKEN_REPLAY,
        targetUserId: userId,
        actorUserId: null,
        sessionPublicId: sessionId,
        mongoSession,
      });

      return true;
    });
  }

  private async revokeSession(
    sessionId: string,
    tokenFamily: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<void> {
    await this.sessionModel.updateOne(
      {
        publicId: sessionId,
        tokenFamily,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
          revokeReason: reason,
        },
      },
    );
  }

  private createDeviceLabel(userAgent?: string): string {
    if (!userAgent?.trim()) {
      return 'Thiết bị không xác định';
    }

    const value = userAgent.slice(0, 512).toLowerCase();

    const browser = value.includes('edg/')
      ? 'Edge'
      : value.includes('firefox/')
        ? 'Firefox'
        : value.includes('chrome/')
          ? 'Chrome'
          : value.includes('safari/')
            ? 'Safari'
            : 'Trình duyệt';

    const operatingSystem =
      value.includes('iphone') || value.includes('ipad')
        ? 'iOS'
        : value.includes('android')
          ? 'Android'
          : value.includes('windows')
            ? 'Windows'
            : value.includes('mac os')
              ? 'macOS'
              : value.includes('linux')
                ? 'Linux'
                : 'thiết bị không xác định';

    return `${browser} trên ${operatingSystem}`.slice(0, 80);
  }

  private isValidSessionId(sessionId: string): boolean {
    return (
      typeof sessionId === 'string' &&
      sessionId.startsWith('ses_') &&
      sessionId.length >= 20 &&
      sessionId.length <= 64
    );
  }

  private toPublicSession(
    session: ActiveSessionRecord,
    currentSessionId: string,
  ): PublicAuthSession {
    return {
      id: session.publicId,
      deviceLabel: session.deviceLabel,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      isCurrent: session.publicId === currentSessionId,
    };
  }

  private parseUserId(userId: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    return new Types.ObjectId(userId);
  }

  private readSecret(configService: ConfigService, key: string): string {
    const rawValue = configService.get<unknown>(key);

    if (typeof rawValue !== 'string') {
      throw new Error(`${key} phải là chuỗi`);
    }

    const value = rawValue.trim();

    if (value.length < 32) {
      throw new Error(`${key} phải có tối thiểu 32 ký tự`);
    }

    return value;
  }

  private readInteger(
    configService: ConfigService,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const rawValue = configService.get<unknown>(key);

    if (
      rawValue === undefined ||
      rawValue === null ||
      (typeof rawValue === 'string' && rawValue.trim() === '')
    ) {
      return fallback;
    }

    const value =
      typeof rawValue === 'number'
        ? rawValue
        : typeof rawValue === 'string'
          ? Number(rawValue.trim())
          : Number.NaN;

    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} phải là số nguyên từ ${min} đến ${max}`);
    }

    return value;
  }

  private addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
  }
}
