import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, createConnection, type Model, Types } from 'mongoose';

import {
  AuthSession,
  AuthSessionSchema,
} from '../../src/modules/auth/schemas/auth-session.schema';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
  OAuthProvider,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { AuthSessionService } from '../../src/modules/auth/services/auth-session.service';
import { GoogleOAuthSignInService } from '../../src/modules/auth/services/google-oauth-sign-in.service';
import { AdminUserRestrictionExpiryService } from '../../src/modules/admin/services/admin-user-restriction-expiry.service';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';
import {
  USER_STATUS,
  User,
  UserSchema,
} from '../../src/modules/users/schemas/user.schema';
import {
  GoogleOAuthSessionHandoff,
  GoogleOAuthSessionHandoffSchema,
} from '../../src/modules/auth/schemas/google-oauth-session-handoff.schema';
import { GoogleOAuthSessionHandoffService } from '../../src/modules/auth/services/google-oauth-session-handoff.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_goauth_signin_it_';
const MAX_DATABASE_NAME_BYTES = 48;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

jest.setTimeout(120_000);

describe('Google OAuth linked-account sign-in MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let identityModel: Model<OAuthIdentity>;
  let sessionModel: Model<AuthSession>;
  let handoffModel: Model<GoogleOAuthSessionHandoff>;

  let identityService: OAuthIdentityService;
  let authSessionService: AuthSessionService;
  let handoffService: GoogleOAuthSessionHandoffService;
  let signInService: GoogleOAuthSignInService;

  let sequence = 0;

  const metadata = {
    userAgent: 'Integration Chrome',
  };

  const createLinkedUser = async (overrides: Record<string, unknown> = {}) => {
    sequence += 1;

    const suffix = `${process.pid}_${sequence}`;
    const providerAccountId = `google-signin-subject-${suffix}`;

    const user = await userModel.create({
      publicId: `usr_signin_${suffix}`,
      username: `signin_${suffix}`,
      fullname: 'Google Sign In User',
      phone: `09${sequence.toString().padStart(8, '0')}`.slice(0, 10),
      email: `signin-${suffix}@example.com`,
      status: USER_STATUS.ACTIVE,
      isDeleted: false,
      ...overrides,
    });

    await identityModel.create({
      userId: user._id,
      provider: OAuthProvider.GOOGLE,
      providerAccountId,
    });

    return {
      user,
      providerAccountId,
    };
  };

  const signIn = (providerAccountId: string, userId: Types.ObjectId) =>
    signInService.signInLinkedAccount(providerAccountId, userId, metadata);

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }

    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES
    ) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    userModel = connection.model<User>(
      'GoogleOAuthSignInUserIntegration',
      UserSchema.clone(),
    );

    identityModel = connection.model<OAuthIdentity>(
      'GoogleOAuthSignInIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );

    sessionModel = connection.model<AuthSession>(
      'GoogleOAuthSignInSessionIntegration',
      AuthSessionSchema.clone(),
    );

    handoffModel = connection.model<GoogleOAuthSessionHandoff>(
      'GoogleOAuthSignInHandoffIntegration',
      GoogleOAuthSessionHandoffSchema.clone(),
    );

    await Promise.all([
      userModel.syncIndexes(),
      identityModel.syncIndexes(),
      sessionModel.syncIndexes(),
      handoffModel.syncIndexes(),
    ]);

    const values: Record<string, string> = {
      JWT_SECRET: 'integration-access-secret-that-is-at-least-32-characters',
      JWT_REFRESH_SECRET:
        'integration-refresh-secret-that-is-different-and-long',
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_SECONDS: '604800',
      REFRESH_TOKEN_HASH_ROUNDS: '8',

      GOOGLE_OAUTH_ENABLED: 'true',
      GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64: Buffer.alloc(32, 21).toString(
        'base64',
      ),
      GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS: '120',
      GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: Buffer.alloc(32, 22).toString(
        'base64',
      ),
    };

    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    identityService = new OAuthIdentityService(identityModel);

    authSessionService = new AuthSessionService(
      sessionModel,
      userModel,
      new JwtService(),
      configService,
      connection,
      {} as AuthAuditService,
    );

    handoffService = new GoogleOAuthSessionHandoffService(
      handoffModel,
      configService,
    );

    signInService = new GoogleOAuthSignInService(
      connection,
      userModel,
      identityService,
      authSessionService,
      handoffService,
      {
        convergeForAuthentication: () => Promise.resolve(null),
      } as unknown as AdminUserRestrictionExpiryService,
    );
  });

  beforeEach(async () => {
    await Promise.all([
      sessionModel.deleteMany({}),
      identityModel.deleteMany({}),
      userModel.deleteMany({}),
      handoffModel.deleteMany({}),
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    try {
      if (
        !connection.name.startsWith(DATABASE_PREFIX) ||
        Buffer.byteLength(connection.name, 'utf8') > MAX_DATABASE_NAME_BYTES
      ) {
        throw new Error(
          `Từ chối xóa database không an toàn: ${connection.name}`,
        );
      }

      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('creates a session for a linked active account using one transaction session', async () => {
    const { user, providerAccountId } = await createLinkedUser({
      failedLoginAttempts: 3,
      failedLoginWindowStartedAt: new Date(Date.now() - 60_000),
      lockedUntil: new Date(Date.now() - 1_000),
    });

    const identitySpy = jest.spyOn(identityService, 'resolveGoogleUserId');

    const sessionSpy = jest.spyOn(authSessionService, 'createSession');

    const handoffSpy = jest.spyOn(handoffService, 'issue');

    const handoff = await signIn(providerAccountId, user._id);

    const result = await handoffService.consume(handoff.rawHandoff);

    const identitySession = identitySpy.mock.calls[0]?.[1];

    const authSession = sessionSpy.mock.calls[0]?.[2];

    const handoffSession = handoffSpy.mock.calls[0]?.[1];

    expect(identitySession).toBeDefined();
    expect(authSession).toBe(identitySession);
    expect(handoffSession).toBe(identitySession);
    expect(handoffSession).toBe(authSession);

    expect(result).toMatchObject({
      message: 'Đăng nhập bằng Google thành công',
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user: {
        id: user.publicId,
        publicId: user.publicId,
        email: user.email,
      },
    });

    const [storedSessionCount, updatedUser] = await Promise.all([
      sessionModel.countDocuments({
        userId: user._id,
      }),
      userModel
        .findById(user._id)
        .select(
          '+failedLoginAttempts ' +
            '+failedLoginWindowStartedAt ' +
            '+lockedUntil',
        )
        .lean()
        .exec(),
    ]);

    expect(storedSessionCount).toBe(1);
    expect(updatedUser?.failedLoginAttempts).toBe(0);
    expect(updatedUser?.failedLoginWindowStartedAt).toBeUndefined();
    expect(updatedUser?.lockedUntil).toBeUndefined();

    const rawUser = await userModel.collection.findOne({
      _id: user._id,
    });

    expect(rawUser).not.toBeNull();
    expect(rawUser).not.toHaveProperty('password');

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(user._id.toString());
    expect(serialized).not.toContain(providerAccountId);
    expect(serialized).not.toContain('failedLoginAttempts');
  });

  it('signs in an existing password account linked to Google', async () => {
    const passwordHash = await bcrypt.hash('Password@123', 8);

    const { user, providerAccountId } = await createLinkedUser({
      password: passwordHash,
    });

    const handoff = await signIn(providerAccountId, user._id);

    const result = await handoffService.consume(handoff.rawHandoff);

    const [storedUser, sessionCount] = await Promise.all([
      userModel.findById(user._id).select('+password').lean().exec(),

      sessionModel.countDocuments({
        userId: user._id,
      }),
    ]);

    expect(result).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user: {
        id: user.publicId,
        email: user.email,
      },
    });

    expect(storedUser?.password).toBe(passwordHash);

    expect(sessionCount).toBe(1);
  });

  it('creates independent sessions for two Google sign-ins', async () => {
    const { user, providerAccountId } = await createLinkedUser();

    const firstHandoff = await signIn(providerAccountId, user._id);

    const secondHandoff = await signIn(providerAccountId, user._id);

    const first = await handoffService.consume(firstHandoff.rawHandoff);

    const second = await handoffService.consume(secondHandoff.rawHandoff);

    expect(first.access_token).not.toBe(second.access_token);

    expect(first.refresh_token).not.toBe(second.refresh_token);

    const sessions = await sessionModel
      .find({
        userId: user._id,
      })
      .lean()
      .exec();

    expect(sessions).toHaveLength(2);

    expect(new Set(sessions.map((session) => session.publicId)).size).toBe(2);

    expect(new Set(sessions.map((session) => session.tokenFamily)).size).toBe(
      2,
    );
  });

  it('rejects when the expected user differs from the linked user', async () => {
    const { user, providerAccountId } = await createLinkedUser();

    await expect(
      signIn(providerAccountId, new Types.ObjectId()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(
      await sessionModel.countDocuments({
        userId: user._id,
      }),
    ).toBe(0);
  });

  it.each([
    [
      'deleted',
      {
        isDeleted: true,
        status: USER_STATUS.ACTIVE,
      },
    ],
    [
      'banned',
      {
        isDeleted: false,
        status: USER_STATUS.BANNED,
      },
    ],
    [
      'reported',
      {
        isDeleted: false,
        status: USER_STATUS.REPORTED,
      },
    ],
  ])(
    'does not create a session for a %s account',
    async (_caseName, overrides) => {
      const { user, providerAccountId } = await createLinkedUser(overrides);

      await expect(signIn(providerAccountId, user._id)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(
        await sessionModel.countDocuments({
          userId: user._id,
        }),
      ).toBe(0);
    },
  );

  it('does not create a session for a locked account', async () => {
    const { user, providerAccountId } = await createLinkedUser({
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });

    let caughtError: unknown;

    try {
      await signIn(providerAccountId, user._id);
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(HttpException);

    if (!(caughtError instanceof HttpException)) {
      throw new Error('Expected HttpException');
    }

    expect(caughtError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(
      await sessionModel.countDocuments({
        userId: user._id,
      }),
    ).toBe(0);
  });

  it('rolls back login-counter reset when session creation fails', async () => {
    const originalWindow = new Date(Date.now() - 120_000);

    const originalExpiredLock = new Date(Date.now() - 1_000);

    const { user, providerAccountId } = await createLinkedUser({
      failedLoginAttempts: 4,
      failedLoginWindowStartedAt: originalWindow,
      lockedUntil: originalExpiredLock,
    });

    const sessionError = new Error('forced session persistence failure');

    jest
      .spyOn(authSessionService, 'createSession')
      .mockRejectedValueOnce(sessionError);

    await expect(signIn(providerAccountId, user._id)).rejects.toBe(
      sessionError,
    );

    const restoredUser = await userModel
      .findById(user._id)
      .select(
        '+failedLoginAttempts ' +
          '+failedLoginWindowStartedAt ' +
          '+lockedUntil',
      )
      .lean()
      .exec();

    expect(restoredUser?.failedLoginAttempts).toBe(4);

    expect(restoredUser?.failedLoginWindowStartedAt?.getTime()).toBe(
      originalWindow.getTime(),
    );

    expect(restoredUser?.lockedUntil?.getTime()).toBe(
      originalExpiredLock.getTime(),
    );

    expect(
      await sessionModel.countDocuments({
        userId: user._id,
      }),
    ).toBe(0);
  });

  it('rolls back user and auth session when handoff issuance fails', async () => {
    const originalWindow = new Date(Date.now() - 120_000);

    const originalLock = new Date(Date.now() - 1_000);

    const { user, providerAccountId } = await createLinkedUser({
      failedLoginAttempts: 4,
      failedLoginWindowStartedAt: originalWindow,
      lockedUntil: originalLock,
    });

    jest
      .spyOn(handoffService, 'issue')
      .mockRejectedValueOnce(new ServiceUnavailableException());

    await expect(signIn(providerAccountId, user._id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const [storedUser, sessionCount, handoffCount] = await Promise.all([
      userModel
        .findById(user._id)
        .select(
          '+failedLoginAttempts ' +
            '+failedLoginWindowStartedAt ' +
            '+lockedUntil',
        )
        .lean()
        .exec(),
      sessionModel.countDocuments({
        userId: user._id,
      }),
      handoffModel.countDocuments({}),
    ]);

    expect(storedUser?.failedLoginAttempts).toBe(4);
    expect(storedUser?.failedLoginWindowStartedAt?.getTime()).toBe(
      originalWindow.getTime(),
    );
    expect(storedUser?.lockedUntil?.getTime()).toBe(originalLock.getTime());
    expect(sessionCount).toBe(0);
    expect(handoffCount).toBe(0);
  });
});
