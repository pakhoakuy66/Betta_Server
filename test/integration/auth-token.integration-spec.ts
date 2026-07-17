import { UnauthorizedException } from '@nestjs/common';
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
import { AuthService } from '../../src/modules/auth/services/auth.service';
import { MailService } from '../../src/modules/auth/services/mail.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
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

type UserFixture = {
  _id: Types.ObjectId;
  publicId: string;
  email: string;
};

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
  let jwtService: JwtService;
  let authService: AuthService;
  let authSessionService: AuthSessionService;

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

  const readAccessPayload = (token: string): AccessTokenPayload =>
    jwtService.verify<AccessTokenPayload>(token, {
      secret: ACCESS_SECRET,
      issuer: AUTH_JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: [AUTH_JWT_ALGORITHM],
    });

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

    await Promise.all([userModel.syncIndexes(), sessionModel.syncIndexes()]);

    jwtService = new JwtService();
    authSessionService = new AuthSessionService(
      sessionModel,
      userModel,
      jwtService,
      configService,
    );

    authService = new AuthService(
      connection,
      userModel,
      mailService as unknown as MailService,
      authSessionService,
    );

    jwtStrategy = new JwtStrategy(configService, userModel, authSessionService);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([sessionModel.deleteMany({}), userModel.deleteMany({})]);
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

  it('creates an auth session without writing users.refreshToken', async () => {
    const fixture = await createUser('login');
    const result = await authService.login(
      { email: fixture.email, password: CURRENT_PASSWORD },
      { userAgent: 'Mozilla/5.0 Chrome/126 Windows' },
    );

    const payload = readAccessPayload(result.access_token);
    const [storedUser, storedSession] = await Promise.all([
      userModel.findById(fixture._id).select('+refreshToken').exec(),
      sessionModel
        .findOne({ userId: fixture._id, publicId: payload.sid })
        .select('+refreshTokenHash')
        .exec(),
    ]);

    expect(storedUser?.refreshToken ?? null).toBeNull();
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

    await authService.changePassword(fixture._id.toString(), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
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
          session.revokeReason === SessionRevokeReason.PASSWORD_CHANGED,
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
      userModel.findById(fixture._id).select('+password +refreshToken').exec(),
      sessionModel
        .findOne({ publicId: readAccessPayload(login.access_token).sid })
        .lean()
        .exec(),
    ]);

    expect(storedUser).toBeTruthy();
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(storedUser?.refreshToken ?? null).toBeNull();
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
        .select(
          '+password +refreshToken +forgotPasswordOtp +forgotPasswordExpiry',
        )
        .exec(),
      sessionModel.findOne({ publicId: payload.sid }).lean().exec(),
    ]);

    expect(storedUser).toBeTruthy();
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, storedUser?.password ?? ''),
    ).toBe(true);
    expect(storedUser?.refreshToken ?? null).toBeNull();
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
