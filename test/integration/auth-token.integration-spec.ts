import {
  ServiceUnavailableException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { Connection, createConnection, Model, Types } from 'mongoose';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
} from '../../src/modules/auth/constants/auth-token.constants';
import type { AccessTokenPayload } from '../../src/modules/auth/interfaces/auth-session.interface';
import {
  AuthSession,
  AuthSessionSchema,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import { AuthSessionService } from '../../src/modules/auth/services/auth-session.service';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../../src/modules/auth/interfaces/auth-audit.interface';
import {
  AuthAuditEvent,
  AuthAuditEventSchema,
} from '../../src/modules/auth/schemas/auth-audit-event.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { AuthService } from '../../src/modules/auth/services/auth.service';
import { AdminUserRestrictionExpiryService } from '../../src/modules/admin/services/admin-user-restriction-expiry.service';
import { MailService } from '../../src/modules/auth/services/mail.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';

const MONGODB_URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';
const TEST_DATABASE_PREFIX = 'betta_auth_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const ACCESS_SECRET = 'integration-access-secret-'.padEnd(48, 'a');
const REFRESH_SECRET = 'integration-refresh-secret-'.padEnd(48, 'b');
const CURRENT_PASSWORD = 'CurrentPassword123.';
const NEW_PASSWORD = 'NewPassword123.';
const RESET_OTP = '123456';
const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

const configService = {
  get: (key: string): unknown =>
    ({
      JWT_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 604800,
      REFRESH_TOKEN_HASH_ROUNDS: 8,
    })[key],
} as ConfigService;

const FORBIDDEN_AUTH_AUDIT_KEY_PATTERN =
  /password|otp|token|hash|secret|ip|useragent/i;

const collectObjectKeys = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => [key, ...collectObjectKeys(nested)],
  );
};

type UserFixture = {
  _id: Types.ObjectId;
  publicId: string;
  email: string;
};

type RefreshResult = Awaited<ReturnType<AuthService['refreshToken']>>;

type AuditInsertManyMethod = (...args: unknown[]) => Promise<unknown>;

jest.setTimeout(60_000);

if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
  throw new Error('Tên integration database vượt quá giới hạn an toàn');
}

if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
  throw new Error('Tên integration database không an toàn');
}

describe('Auth runtime MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let sessionModel: Model<AuthSession>;
  let auditModel: Model<AuthAuditEvent>;
  let jwtService: JwtService;
  let authService: AuthService;
  let authSessionService: AuthSessionService;
  let authAuditService: AuthAuditService;

  let jwtStrategy: JwtStrategy;

  const mailService = {
    sendOtpEmail: jest.fn<(email: string, otp: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const createUser = async (suffix: string): Promise<UserFixture> => {
    const passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 12);
    const document = await userModel.create({
      publicId: `usr_auth_it_${suffix}`,
      username: `auth_it_${suffix}`,
      fullname: `Auth Integration ${suffix}`,
      phone: `091${suffix.padStart(7, '0').slice(-7)}`,
      email: `auth_it_${suffix}@example.com`,
      password: passwordHash,
      status: 'active',
      isDeleted: false,
    });

    return {
      _id: document._id,
      publicId: document.publicId,
      email: document.email,
    };
  };

  let passwordlessSequence = 0;

  const createPasswordlessUser = async (): Promise<UserFixture> => {
    passwordlessSequence += 1;
    const suffix = `passwordless_${passwordlessSequence}`;

    const document = await userModel.create({
      publicId: `usr_${suffix}`,
      username: suffix,
      fullname: 'Google Only User',
      phone: `092${passwordlessSequence.toString().padStart(7, '0')}`,
      email: `${suffix}@example.com`,
      status: 'active',
      isDeleted: false,
    });

    return {
      _id: document._id,
      publicId: document.publicId,
      email: document.email,
    };
  };

  const readAccessPayload = (token: string): AccessTokenPayload =>
    jwtService.verify<AccessTokenPayload>(token, {
      secret: ACCESS_SECRET,
      issuer: AUTH_JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: [AUTH_JWT_ALGORITHM],
    });

  const expectTokenPairIsUnusable = async (
    tokens: RefreshResult,
  ): Promise<void> => {
    await expect(
      authService.refreshToken(tokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      jwtStrategy.validate(readAccessPayload(tokens.access_token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  };

  const expectRefreshResultIsUnusable = async (
    result: PromiseSettledResult<RefreshResult>,
  ): Promise<void> => {
    if (result.status === 'rejected') {
      expect(result.reason as unknown).toBeInstanceOf(UnauthorizedException);
      return;
    }

    await expectTokenPairIsUnusable(result.value);
  };

  const setResetOtp = async (userId: Types.ObjectId): Promise<void> => {
    await userModel.updateOne(
      { _id: userId },
      {
        $set: {
          forgotPasswordOtp: await bcrypt.hash(RESET_OTP, 8),
          forgotPasswordExpiry: new Date(Date.now() + 60_000),
          forgotPasswordAttempts: 0,
        },
      },
    );
  };

  const createAuditInsertSpy = () =>
    jest.spyOn(
      auditModel as unknown as { insertMany: AuditInsertManyMethod },
      'insertMany',
    );

  const createNonTransientAuditError = (): Error =>
    Object.assign(new Error('Audit persistence failed'), {
      name: 'MongoServerSelectionError',
    });

  beforeAll(async () => {
    const uri = process.env[MONGODB_URI_ENV];

    if (!uri) {
      throw new Error(
        `${MONGODB_URI_ENV} chưa được cấu hình. ` +
          'Không dùng database developer/production cho integration test.',
      );
    }

    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(`${CONFIRMATION_ENV} phải bằng ${REQUIRED_CONFIRMATION}`);
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    if (!connection.name.startsWith(TEST_DATABASE_PREFIX)) {
      await connection.close();
      throw new Error(`Từ chối chạy trên database: ${connection.name}`);
    }

    userModel = connection.model(User.name, UserSchema);
    sessionModel = connection.model(AuthSession.name, AuthSessionSchema);
    auditModel = connection.model(AuthAuditEvent.name, AuthAuditEventSchema);

    await Promise.all([
      userModel.syncIndexes(),
      sessionModel.syncIndexes(),
      auditModel.syncIndexes(),
    ]);

    jwtService = new JwtService();

    authAuditService = new AuthAuditService(auditModel, configService);

    authSessionService = new AuthSessionService(
      sessionModel,
      userModel,
      jwtService,
      configService,
      connection,
      authAuditService,
    );

    authService = new AuthService(
      connection,
      userModel,
      mailService as unknown as MailService,
      authSessionService,
      authAuditService,
      {
        convergeForAuthentication: () => Promise.resolve(null),
      } as unknown as AdminUserRestrictionExpiryService,
    );

    jwtStrategy = new JwtStrategy(configService, userModel, authSessionService);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
      auditModel.collection.deleteMany({}),
      sessionModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;

    if (!connection.name.startsWith(TEST_DATABASE_PREFIX)) {
      await connection.close();
      throw new Error(`Từ chối xóa database không an toàn: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('enforces password storage and projection contracts', async () => {
    const localUser = await createUser('projection');
    const googleUser = await createPasswordlessUser();

    const [defaultUser, selectedUser, rawGoogleUser] = await Promise.all([
      userModel.findById(localUser._id).lean().exec(),
      userModel.findById(localUser._id).select('+password').lean().exec(),
      userModel.collection.findOne({
        _id: googleUser._id,
      }),
    ]);

    expect(defaultUser?.password).toBeUndefined();
    expect(selectedUser?.password).toEqual(expect.any(String));
    expect(rawGoogleUser).not.toHaveProperty('password');
  });

  it('rejects password login without locking a Google-only account', async () => {
    const fixture = await createPasswordlessUser();

    await expect(
      authService.login(
        {
          email: fixture.email,
          password: 'AnyPassword123.',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const storedUser = await userModel
      .findById(fixture._id)
      .select('+failedLoginAttempts +lockedUntil')
      .lean()
      .exec();

    expect(storedUser?.failedLoginAttempts).toBe(0);
    expect(storedUser?.lockedUntil ?? null).toBeNull();

    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
      }),
    ).toBe(0);

    expect(
      await auditModel.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ).toBe(0);
  });

  it('rejects a revoked access token before disclosing a restriction', async () => {
    const fixture = await createUser('restricted-revoked-access');
    const login = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      { userAgent: 'Restricted access integration' },
    );
    const payload = readAccessPayload(login.access_token);
    const now = new Date();

    await Promise.all([
      userModel.updateOne(
        { _id: fixture._id },
        {
          $set: {
            restriction: {
              type: UserRestrictionType.TEMPORARY_SUSPENSION,
              effectiveAt: now,
              expiresAt: new Date(now.getTime() + 60_000),
              supportReference: 'sup_auth_integration',
              publicReasonCode: 'community_policy_review',
            },
          },
          $inc: { authzVersion: 1 },
        },
      ),
      sessionModel.updateOne(
        { userId: fixture._id, publicId: payload.sid },
        {
          $set: {
            revokedAt: now,
            revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
          },
        },
      ),
    ]);

    await expect(jwtStrategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      authService.refreshToken(login.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('establishes the first password using OTP', async () => {
    const fixture = await createPasswordlessUser();
    await setResetOtp(fixture._id);

    await authService.resetPassword({
      email: fixture.email,
      otp: RESET_OTP,
      newPassword: NEW_PASSWORD,
    });

    const storedUser = await userModel
      .findById(fixture._id)
      .select(
        '+password +forgotPasswordOtp ' +
          '+forgotPasswordExpiry +forgotPasswordAttempts',
      )
      .lean()
      .exec();

    expect(await bcrypt.compare(NEW_PASSWORD, storedUser?.password ?? '')).toBe(
      true,
    );

    expect(storedUser?.forgotPasswordOtp).toBeUndefined();
    expect(storedUser?.forgotPasswordExpiry).toBeUndefined();
    expect(storedUser?.forgotPasswordAttempts).toBe(0);

    await expect(
      authService.login(
        {
          email: fixture.email,
          password: NEW_PASSWORD,
        },
        {},
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('allows only one concurrent first-password reset', async () => {
    const fixture = await createPasswordlessUser();
    await setResetOtp(fixture._id);

    const results = await Promise.allSettled([
      authService.resetPassword({
        email: fixture.email,
        otp: RESET_OTP,
        newPassword: NEW_PASSWORD,
      }),
      authService.resetPassword({
        email: fixture.email,
        otp: RESET_OTP,
        newPassword: NEW_PASSWORD,
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );

    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );

    expect(
      await auditModel.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_RESET,
      }),
    ).toBe(1);
  });

  it('creates an auth session without writing users.refreshToken', async () => {
    const fixture = await createUser('login');
    const result = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Mozilla/5.0 Chrome/126 Windows' },
    );

    const payload = readAccessPayload(result.access_token);
    const [storedUser, storedSession] = await Promise.all([
      userModel.collection.findOne(
        { _id: fixture._id },
        { projection: { refreshToken: 1 } },
      ),
      sessionModel
        .findOne({ userId: fixture._id, publicId: payload.sid })
        .select('+refreshTokenHash')
        .exec(),
    ]);

    expect(storedUser).not.toHaveProperty('refreshToken');
    expect(storedSession).toBeTruthy();
    expect(storedSession?.refreshTokenHash).not.toBe(result.refresh_token);
    expect(result.user).toEqual(
      expect.objectContaining({
        id: fixture.publicId,
        publicId: fixture.publicId,
        email: fixture.email,
      }),
    );
    expect(result.user).not.toHaveProperty('_id');
  });

  it('keeps two logins independent and rotates only one session', async () => {
    const fixture = await createUser('rotation');
    const loginA = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );
    const loginB = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Firefox Linux' },
    );

    const sidA = readAccessPayload(loginA.access_token).sid;
    const sidB = readAccessPayload(loginB.access_token).sid;
    expect(sidA).not.toBe(sidB);

    const sessionBBefore = await sessionModel
      .findOne({ publicId: sidB })
      .select('+refreshTokenHash')
      .lean()
      .exec();

    const rotatedA = await authService.refreshToken(loginA.refresh_token);
    const [sessionAAfter, sessionBAfter] = await Promise.all([
      sessionModel
        .findOne({ publicId: sidA })
        .select('+refreshTokenHash')
        .lean()
        .exec(),
      sessionModel
        .findOne({ publicId: sidB })
        .select('+refreshTokenHash')
        .lean()
        .exec(),
    ]);

    expect(rotatedA.refresh_token).not.toBe(loginA.refresh_token);
    expect(sessionAAfter?.tokenVersion).toBe(1);
    expect(sessionBAfter?.tokenVersion).toBe(0);
    expect(sessionBAfter?.refreshTokenHash).toBe(
      sessionBBefore?.refreshTokenHash,
    );
  });

  it('audits confirmed refresh-token replay and revokes the session', async () => {
    const fixture = await createUser('refresh-replay-audit');

    const login = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {
        userAgent: 'Chrome Windows',
      },
    );

    const sessionId = readAccessPayload(login.access_token).sid;

    const rotated = await authService.refreshToken(login.refresh_token);

    await expect(
      authService.refreshToken(login.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const [storedSession, audits] = await Promise.all([
      sessionModel
        .findOne({
          userId: fixture._id,
          publicId: sessionId,
        })
        .lean()
        .exec(),

      auditModel.collection
        .find({
          targetUserId: fixture._id,
          eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
        })
        .toArray(),
    ]);

    expect(storedSession).toEqual(
      expect.objectContaining({
        revokedAt: expect.any(Date),
        revokeReason: SessionRevokeReason.REFRESH_REPLAY,
      }),
    );

    expect(audits).toHaveLength(1);

    expect(audits[0]).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
        outcome: AuthAuditOutcome.DENIED,
        reasonCode: AuthAuditReasonCode.REFRESH_TOKEN_REPLAY,
        targetUserId: fixture._id,
        actorUserId: null,
        sessionPublicId: sessionId,
      }),
    );

    expect(
      collectObjectKeys(audits[0]).filter((key) =>
        FORBIDDEN_AUTH_AUDIT_KEY_PATTERN.test(key),
      ),
    ).toEqual([]);

    expect(
      Object.keys((audits[0]?.metadata ?? {}) as Record<string, unknown>),
    ).toHaveLength(0);

    const serializedAudit = JSON.stringify(audits[0]);

    expect(serializedAudit).not.toContain(login.refresh_token);
    expect(serializedAudit).not.toContain(rotated.refresh_token);
    expect(serializedAudit).not.toContain(login.access_token);

    await expectTokenPairIsUnusable(rotated);
  });

  it('writes one audit for concurrent confirmed refresh replay', async () => {
    const fixture = await createUser('refresh-replay-concurrent');

    const login = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {},
    );

    const sessionId = readAccessPayload(login.access_token).sid;

    await authService.refreshToken(login.refresh_token);

    const results = await Promise.allSettled([
      authService.refreshToken(login.refresh_token),
      authService.refreshToken(login.refresh_token),
    ]);

    for (const result of results) {
      expect(result.status).toBe('rejected');

      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(UnauthorizedException);
      }
    }

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
      }),
    ).toBe(1);

    const storedSession = await sessionModel
      .findOne({
        userId: fixture._id,
        publicId: sessionId,
      })
      .lean()
      .exec();

    expect(storedSession?.revokedAt).toBeInstanceOf(Date);

    expect(storedSession?.revokeReason).toBe(
      SessionRevokeReason.REFRESH_REPLAY,
    );
  });

  it('rolls back refresh replay revocation when audit persistence fails', async () => {
    const fixture = await createUser('refresh-replay-audit-failure');

    const login = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {},
    );

    const sessionId = readAccessPayload(login.access_token).sid;

    const rotated = await authService.refreshToken(login.refresh_token);

    const auditInsertSpy = createAuditInsertSpy();

    auditInsertSpy.mockImplementationOnce(() =>
      Promise.reject(createNonTransientAuditError()),
    );

    try {
      await expect(
        authService.refreshToken(login.refresh_token),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      auditInsertSpy.mockRestore();
    }

    const storedSession = await sessionModel
      .findOne({
        userId: fixture._id,
        publicId: sessionId,
      })
      .lean()
      .exec();

    expect(storedSession?.revokedAt).toBeNull();
    expect(storedSession?.revokeReason).toBeNull();
    expect(storedSession?.tokenVersion).toBe(1);

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
      }),
    ).toBe(0);

    await expect(
      authService.refreshToken(rotated.refresh_token),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('logs out only the current session', async () => {
    const fixture = await createUser('logout');
    const loginA = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );
    const loginB = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Firefox Linux' },
    );

    const sidA = readAccessPayload(loginA.access_token).sid;
    const sidB = readAccessPayload(loginB.access_token).sid;

    await authService.logout(fixture._id.toString(), sidA);

    const [sessionA, sessionB] = await Promise.all([
      sessionModel.findOne({ publicId: sidA }).lean().exec(),
      sessionModel.findOne({ publicId: sidB }).lean().exec(),
    ]);

    expect(sessionA?.revokeReason).toBe(SessionRevokeReason.LOGOUT);
    expect(sessionA?.revokedAt).toBeInstanceOf(Date);
    expect(sessionB?.revokedAt).toBeNull();

    await expect(
      authService.refreshToken(loginA.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.refreshToken(loginB.refresh_token),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('leaves no usable token after concurrent logout and refresh', async () => {
    const fixture = await createUser('logout-refresh-race');

    const login = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {
        userAgent: 'Chrome Windows',
      },
    );

    // Session đã rotation vẫn phải được logout đúng.
    const currentTokens = await authService.refreshToken(login.refresh_token);

    const currentAccessPayload = readAccessPayload(currentTokens.access_token);

    const [logoutResult, refreshResult] = await Promise.allSettled([
      authService.logout(fixture._id.toString(), currentAccessPayload.sid),
      authService.refreshToken(currentTokens.refresh_token),
    ]);

    expect(logoutResult.status).toBe('fulfilled');

    const storedSession = await sessionModel
      .findOne({
        userId: fixture._id,
        publicId: currentAccessPayload.sid,
      })
      .lean()
      .exec();

    expect(storedSession).toBeTruthy();
    expect(storedSession?.revokedAt).toBeInstanceOf(Date);
    expect(storedSession?.revokeReason).toBe(SessionRevokeReason.LOGOUT);

    const revokedAt = storedSession?.revokedAt;

    // Token ban đầu từ login.
    await expectTokenPairIsUnusable(login);

    // Token hiện hành sau pre-rotation.
    await expectTokenPairIsUnusable(currentTokens);

    // Token có thể được cấp bởi refresh trong race.
    await expectRefreshResultIsUnusable(refreshResult);

    // Replay không được ghi đè trạng thái logout.
    const finalSession = await sessionModel
      .findOne({
        userId: fixture._id,
        publicId: currentAccessPayload.sid,
      })
      .lean()
      .exec();

    expect(finalSession).toEqual(
      expect.objectContaining({
        revokedAt: expect.any(Date),
        revokeReason: SessionRevokeReason.LOGOUT,
      }),
    );

    expect(finalSession?.revokedAt).toEqual(revokedAt);

    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(0);
  });

  it('leaves no active session after concurrent revoke-all and refresh', async () => {
    const fixture = await createUser('revoke-all-refresh-race');

    const loginA = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {
        userAgent: 'Chrome Windows',
      },
    );

    const loginB = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      {
        userAgent: 'Firefox Linux',
      },
    );

    // Cả hai session đã rotation vẫn phải bị revoke-all.
    const currentA = await authService.refreshToken(loginA.refresh_token);

    const currentB = await authService.refreshToken(loginB.refresh_token);

    const accessPayloadA = readAccessPayload(currentA.access_token);

    const accessPayloadB = readAccessPayload(currentB.access_token);

    expect(accessPayloadA.sid).not.toBe(accessPayloadB.sid);

    const [revokeAllResult, refreshResultA, refreshResultB] =
      await Promise.allSettled([
        authSessionService.logoutAllSessions(fixture._id.toString()),
        authService.refreshToken(currentA.refresh_token),
        authService.refreshToken(currentB.refresh_token),
      ]);

    expect(revokeAllResult.status).toBe('fulfilled');

    if (revokeAllResult.status === 'fulfilled') {
      expect(revokeAllResult.value).toBe(2);
    }

    const storedSessions = await sessionModel
      .find({
        userId: fixture._id,
      })
      .lean()
      .exec();

    expect(storedSessions).toHaveLength(2);

    expect(
      storedSessions.every(
        (session) =>
          session.revokedAt instanceof Date &&
          session.revokeReason === SessionRevokeReason.LOGOUT_ALL,
      ),
    ).toBe(true);

    // Token ban đầu trước pre-rotation.
    await expectTokenPairIsUnusable(loginA);
    await expectTokenPairIsUnusable(loginB);

    // Token hiện hành sau pre-rotation.
    await expectTokenPairIsUnusable(currentA);
    await expectTokenPairIsUnusable(currentB);

    // Token có thể được cấp bởi refresh trong race.
    await expectRefreshResultIsUnusable(refreshResultA);

    await expectRefreshResultIsUnusable(refreshResultB);

    /*
     * Query sau mọi reuse attempt để chứng minh session
     * không được khôi phục và reason không bị ghi đè.
     */
    const finalSessions = await sessionModel
      .find({
        userId: fixture._id,
      })
      .lean()
      .exec();

    expect(finalSessions).toHaveLength(2);

    expect(
      finalSessions.every(
        (session) =>
          session.revokedAt instanceof Date &&
          session.revokeReason === SessionRevokeReason.LOGOUT_ALL,
      ),
    ).toBe(true);

    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(0);
  });

  it('revokes every session after changing password', async () => {
    const fixture = await createUser('change-password');

    const loginA = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      { userAgent: 'Chrome Windows' },
    );

    const loginB = await authService.login(
      {
        email: fixture.email,
        password: CURRENT_PASSWORD,
      },
      { userAgent: 'Firefox Linux' },
    );

    const preRevokedLogin = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Safari macOS' },
    );
    const activeSessionIds = [
      readAccessPayload(loginA.access_token).sid,
      readAccessPayload(loginB.access_token).sid,
    ];
    const preRevokedSessionId = readAccessPayload(
      preRevokedLogin.access_token,
    ).sid;
    const originalRevokedAt = new Date(Date.now() - 1_000);

    await sessionModel.updateOne(
      { publicId: preRevokedSessionId },
      {
        $set: {
          revokedAt: originalRevokedAt,
          revokeReason: SessionRevokeReason.LOGOUT,
        },
      },
    );

    await authService.changePassword(fixture._id.toString(), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    const [newlyRevokedSessions, unchangedSession, audit] = await Promise.all([
      sessionModel
        .find({ publicId: { $in: activeSessionIds } })
        .lean()
        .exec(),
      sessionModel.findOne({ publicId: preRevokedSessionId }).lean().exec(),
      auditModel.collection.findOne({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
      }),
    ]);

    expect(newlyRevokedSessions).toHaveLength(2);
    expect(
      newlyRevokedSessions.every(
        (session) =>
          session.revokedAt instanceof Date &&
          session.revokeReason === SessionRevokeReason.PASSWORD_CHANGED,
      ),
    ).toBe(true);
    expect(unchangedSession?.revokedAt?.getTime()).toBe(
      originalRevokedAt.getTime(),
    );
    expect(unchangedSession?.revokeReason).toBe(SessionRevokeReason.LOGOUT);
    expect(audit).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
        targetUserId: fixture._id,
        actorUserId: fixture._id,
        metadata: expect.objectContaining({ affectedSessionCount: 2 }),
      }),
    );

    await expect(
      jwtStrategy.validate(readAccessPayload(loginA.access_token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      jwtStrategy.validate(readAccessPayload(loginB.access_token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      authService.refreshToken(loginA.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      authService.refreshToken(loginB.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      authService.login(
        {
          email: fixture.email,
          password: CURRENT_PASSWORD,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      authService.login(
        {
          email: fixture.email,
          password: NEW_PASSWORD,
        },
        {},
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('revokes every session after resetting password', async () => {
    const fixture = await createUser('reset-password');
    const [loginA, loginB] = await Promise.all([
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Chrome Windows' },
      ),
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Firefox Linux' },
      ),
    ]);

    await setResetOtp(fixture._id);

    await authService.resetPassword({
      email: fixture.email,
      otp: RESET_OTP,
      newPassword: NEW_PASSWORD,
    });

    const storedSessions = await sessionModel
      .find({ userId: fixture._id })
      .lean()
      .exec();

    expect(storedSessions).toHaveLength(2);
    expect(
      storedSessions.every(
        (session) =>
          session.revokedAt instanceof Date &&
          session.revokeReason === SessionRevokeReason.PASSWORD_RESET,
      ),
    ).toBe(true);

    await expect(
      jwtStrategy.validate(readAccessPayload(loginA.access_token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      jwtStrategy.validate(readAccessPayload(loginB.access_token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.refreshToken(loginA.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.refreshToken(loginB.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.login({ email: fixture.email, password: NEW_PASSWORD }, {}),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('rolls back password changes when session revocation fails', async () => {
    const fixture = await createUser('password-rollback');
    const login = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );
    const revokeError = new Error('forced session revocation failure');
    const revokeSpy = jest
      .spyOn(authSessionService, 'revokeAllSessions')
      .mockRejectedValueOnce(revokeError);

    try {
      await expect(
        authService.changePassword(fixture._id.toString(), {
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toBe(revokeError);
    } finally {
      revokeSpy.mockRestore();
    }

    const [storedUser, storedSession] = await Promise.all([
      userModel.findById(fixture._id).select('+password').exec(),
      sessionModel
        .findOne({ publicId: readAccessPayload(login.access_token).sid })
        .lean()
        .exec(),
    ]);

    expect(storedUser).toBeTruthy();
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(storedSession?.revokedAt).toBeNull();
    await expect(
      jwtStrategy.validate(readAccessPayload(login.access_token)),
    ).resolves.toEqual(
      expect.objectContaining({
        _id: fixture._id.toString(),
        sessionId: readAccessPayload(login.access_token).sid,
      }),
    );
  });

  it('rolls back password changes when audit persistence fails', async () => {
    const fixture = await createUser('password-audit-rollback');
    await Promise.all([
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Chrome Windows' },
      ),
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Firefox Linux' },
      ),
    ]);
    const originalActiveSessionCount = await sessionModel.countDocuments({
      userId: fixture._id,
      revokedAt: null,
    });
    const auditInsertSpy = createAuditInsertSpy();
    auditInsertSpy.mockImplementationOnce(() =>
      Promise.reject(createNonTransientAuditError()),
    );

    try {
      await expect(
        authService.changePassword(fixture._id.toString(), {
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      auditInsertSpy.mockRestore();
    }

    const storedUser = await userModel
      .findById(fixture._id)
      .select('+password')
      .exec();

    expect(storedUser).not.toBeNull();
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, storedUser?.password ?? '')).toBe(
      false,
    );
    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(originalActiveSessionCount);
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
      }),
    ).toBe(0);
  });

  it('rolls back password reset and preserves OTP when revocation fails', async () => {
    const fixture = await createUser('reset-rollback');
    const login = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );
    await setResetOtp(fixture._id);

    const revokeError = new Error('forced reset revocation failure');
    const revokeSpy = jest
      .spyOn(authSessionService, 'revokeAllSessions')
      .mockRejectedValueOnce(revokeError);

    try {
      await expect(
        authService.resetPassword({
          email: fixture.email,
          otp: RESET_OTP,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toBe(revokeError);
    } finally {
      revokeSpy.mockRestore();
    }

    const payload = readAccessPayload(login.access_token);
    const [storedUser, storedSession] = await Promise.all([
      userModel
        .findById(fixture._id)
        .select('+password +forgotPasswordOtp +forgotPasswordExpiry')
        .exec(),
      sessionModel.findOne({ publicId: payload.sid }).lean().exec(),
    ]);

    expect(storedUser).toBeTruthy();
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(storedUser?.forgotPasswordOtp).toBeTruthy();
    expect(storedUser?.forgotPasswordExpiry).toBeInstanceOf(Date);
    expect(storedSession?.revokedAt).toBeNull();
    await expect(jwtStrategy.validate(payload)).resolves.toEqual(
      expect.objectContaining({
        _id: fixture._id.toString(),
        sessionId: payload.sid,
      }),
    );
  });

  it('rolls back password reset when audit persistence fails', async () => {
    const fixture = await createUser('reset-audit-rollback');
    await Promise.all([
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Chrome Windows' },
      ),
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Firefox Linux' },
      ),
    ]);
    await setResetOtp(fixture._id);

    const beforeReset = await userModel
      .findById(fixture._id)
      .select(
        '+password +forgotPasswordOtp +forgotPasswordExpiry +forgotPasswordAttempts',
      )
      .lean()
      .exec();
    const originalActiveSessionCount = await sessionModel.countDocuments({
      userId: fixture._id,
      revokedAt: null,
    });
    const auditInsertSpy = createAuditInsertSpy();
    auditInsertSpy.mockImplementationOnce(() =>
      Promise.reject(createNonTransientAuditError()),
    );

    try {
      await expect(
        authService.resetPassword({
          email: fixture.email,
          otp: RESET_OTP,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      auditInsertSpy.mockRestore();
    }

    const storedUser = await userModel
      .findById(fixture._id)
      .select(
        '+password +forgotPasswordOtp +forgotPasswordExpiry +forgotPasswordAttempts',
      )
      .lean()
      .exec();

    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, storedUser?.password ?? '')).toBe(
      false,
    );
    expect(storedUser?.forgotPasswordOtp).toBe(beforeReset?.forgotPasswordOtp);
    expect(storedUser?.forgotPasswordExpiry?.getTime()).toBe(
      beforeReset?.forgotPasswordExpiry?.getTime(),
    );
    expect(storedUser?.forgotPasswordAttempts).toBe(
      beforeReset?.forgotPasswordAttempts,
    );
    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(originalActiveSessionCount);
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_RESET,
      }),
    ).toBe(0);
  });

  it('allows only one concurrent reset to revoke sessions', async () => {
    const fixture = await createUser('reset-cas');
    await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );

    await setResetOtp(fixture._id);

    const revokeSpy = jest.spyOn(authSessionService, 'revokeAllSessions');
    let results: PromiseSettledResult<unknown>[];

    try {
      results = await Promise.allSettled([
        authService.resetPassword({
          email: fixture.email,
          otp: RESET_OTP,
          newPassword: NEW_PASSWORD,
        }),
        authService.resetPassword({
          email: fixture.email,
          otp: RESET_OTP,
          newPassword: NEW_PASSWORD,
        }),
      ]);

      expect(revokeSpy).toHaveBeenCalledTimes(1);
    } finally {
      revokeSpy.mockRestore();
    }

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(0);
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_RESET,
      }),
    ).toBe(1);
  });

  it('allows only one concurrent password change to write an audit', async () => {
    const fixture = await createUser('change-cas');
    await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Chrome Windows' },
    );

    const outcomes = await Promise.allSettled([
      authService.changePassword(fixture._id.toString(), {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      }),
      authService.changePassword(fixture._id.toString(), {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      }),
    ]);

    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
      }),
    ).toBe(1);
  });

  it('leaves no old-password session after concurrent login and password change', async () => {
    const fixture = await createUser('login-change-race');
    await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Existing Chrome session' },
    );

    const [changeResult] = await Promise.allSettled([
      authService.changePassword(fixture._id.toString(), {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      }),
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        { userAgent: 'Concurrent Firefox login' },
      ),
    ]);

    expect(changeResult.status).toBe('fulfilled');
    expect(
      await sessionModel.countDocuments({
        userId: fixture._id,
        revokedAt: null,
      }),
    ).toBe(0);

    await expect(
      authService.login(
        { email: fixture.email, password: CURRENT_PASSWORD },
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      authService.login({ email: fixture.email, password: NEW_PASSWORD }, {}),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('locks on the fifth failure and writes one safe audit', async () => {
    const fixture = await createUser('account-lock');

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        authService.login(
          {
            email: fixture.email,
            password: 'WrongPassword123.',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    const beforeThreshold = await userModel
      .findById(fixture._id)
      .select(
        '+failedLoginAttempts ' + '+failedLoginWindowStartedAt +lockedUntil',
      )
      .lean()
      .exec();

    expect(beforeThreshold?.failedLoginAttempts).toBe(4);
    expect(beforeThreshold?.lockedUntil ?? null).toBeNull();
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ).toBe(0);

    const lockError = await authService
      .login(
        {
          email: fixture.email,
          password: 'WrongPassword123.',
        },
        {},
      )
      .catch((error: unknown) => error);

    expect(lockError).toBeInstanceOf(HttpException);
    expect((lockError as HttpException).getStatus()).toBe(429);

    const [lockedUser, audit] = await Promise.all([
      userModel
        .findById(fixture._id)
        .select('+failedLoginAttempts +lockedUntil')
        .lean()
        .exec(),
      auditModel.collection.findOne({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ]);

    expect(lockedUser?.failedLoginAttempts).toBe(5);
    expect(lockedUser?.lockedUntil).toBeInstanceOf(Date);

    expect(audit).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.LOGIN_FAILURE_THRESHOLD,
        targetUserId: fixture._id,
        actorUserId: null,
      }),
    );

    expect(
      collectObjectKeys(audit).filter((key) =>
        FORBIDDEN_AUTH_AUDIT_KEY_PATTERN.test(key),
      ),
    ).toEqual([]);

    expect(
      Object.keys((audit?.metadata ?? {}) as Record<string, unknown>),
    ).toHaveLength(0);

    const originalLockedUntil = lockedUser?.lockedUntil?.getTime();

    const repeatedError = await authService
      .login(
        {
          email: fixture.email,
          password: 'WrongPassword123.',
        },
        {},
      )
      .catch((error: unknown) => error);

    expect((repeatedError as HttpException).getStatus()).toBe(429);

    const afterRepeatedAttempt = await userModel
      .findById(fixture._id)
      .select('+failedLoginAttempts +lockedUntil')
      .lean()
      .exec();

    expect(afterRepeatedAttempt?.failedLoginAttempts).toBe(5);
    expect(afterRepeatedAttempt?.lockedUntil?.getTime()).toBe(
      originalLockedUntil,
    );

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ).toBe(1);
  });

  it('rolls back account lock when audit persistence fails', async () => {
    const fixture = await createUser('account-lock-rollback');
    const windowStartedAt = new Date();

    await userModel.updateOne(
      { _id: fixture._id },
      {
        $set: {
          failedLoginAttempts: 4,
          failedLoginWindowStartedAt: windowStartedAt,
          lockedUntil: null,
        },
      },
    );

    const auditInsertSpy = createAuditInsertSpy();

    auditInsertSpy.mockImplementationOnce(() =>
      Promise.reject(createNonTransientAuditError()),
    );

    try {
      await expect(
        authService.login(
          {
            email: fixture.email,
            password: 'WrongPassword123.',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      auditInsertSpy.mockRestore();
    }

    const storedUser = await userModel
      .findById(fixture._id)
      .select(
        '+failedLoginAttempts ' + '+failedLoginWindowStartedAt +lockedUntil',
      )
      .lean()
      .exec();

    expect(storedUser?.failedLoginAttempts).toBe(4);
    expect(storedUser?.lockedUntil ?? null).toBeNull();
    expect(storedUser?.failedLoginWindowStartedAt?.getTime()).toBe(
      windowStartedAt.getTime(),
    );

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ).toBe(0);
  });

  it('creates one audit and returns 429 for concurrent threshold attempts', async () => {
    const fixture = await createUser('account-lock-race');

    await userModel.updateOne(
      { _id: fixture._id },
      {
        $set: {
          failedLoginAttempts: 4,
          failedLoginWindowStartedAt: new Date(),
          lockedUntil: null,
        },
      },
    );

    const outcomes = await Promise.allSettled([
      authService.login(
        {
          email: fixture.email,
          password: 'WrongPassword123.',
        },
        {},
      ),
      authService.login(
        {
          email: fixture.email,
          password: 'WrongPassword123.',
        },
        {},
      ),
    ]);

    expect(outcomes).toHaveLength(2);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');

      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(HttpException);
        expect((outcome.reason as HttpException).getStatus()).toBe(429);
      }
    }

    const storedUser = await userModel
      .findById(fixture._id)
      .select('+failedLoginAttempts +lockedUntil')
      .lean()
      .exec();

    expect(storedUser?.failedLoginAttempts).toBe(5);
    expect(storedUser?.lockedUntil).toBeInstanceOf(Date);

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: fixture._id,
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
      }),
    ).toBe(1);
  });

  it('rejects a legacy refresh token without an auth session', async () => {
    const fixture = await createUser('legacy');
    const legacyToken = jwtService.sign(
      { sub: fixture._id.toString() },
      { secret: ACCESS_SECRET, expiresIn: '7d' },
    );

    await expect(authService.refreshToken(legacyToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects refresh after the account is banned', async () => {
    const fixture = await createUser('banned');
    const login = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      {},
    );

    await userModel.updateOne(
      { _id: fixture._id },
      { $set: { status: 'banned' } },
    );

    await expect(
      authService.refreshToken(login.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
