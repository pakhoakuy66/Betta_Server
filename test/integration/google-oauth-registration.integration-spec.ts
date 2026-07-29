import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
import { type Connection, createConnection, type Model } from 'mongoose';

import type { CompleteGoogleOAuthRegistrationDto } from '../../src/modules/auth/dto/complete-google-oauth-registration.dto';
import {
  AuthSession,
  AuthSessionSchema,
} from '../../src/modules/auth/schemas/auth-session.schema';
import {
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantSchema,
} from '../../src/modules/auth/schemas/google-oauth-continuation-grant.schema';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
  OAuthProvider,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { AuthSessionService } from '../../src/modules/auth/services/auth-session.service';
import { GoogleOAuthContinuationGrantService } from '../../src/modules/auth/services/google-oauth-continuation-grant.service';
import { GoogleOAuthRegistrationService } from '../../src/modules/auth/services/google-oauth-registration.service';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_goauth_reg_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

jest.setTimeout(120_000);

describe('Google OAuth registration MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let grantModel: Model<GoogleOAuthContinuationGrant>;
  let identityModel: Model<OAuthIdentity>;
  let sessionModel: Model<AuthSession>;

  let continuationService: GoogleOAuthContinuationGrantService;
  let identityService: OAuthIdentityService;
  let authSessionService: AuthSessionService;
  let registrationService: GoogleOAuthRegistrationService;

  let sequence = 0;

  const issueGrant = (
    email: string,
    providerAccountId: string,
    fullname: string | null = 'Google User',
  ) =>
    continuationService.issueRegistrationGrant({
      email,
      providerAccountId,
      fullname,
      avatar: 'https://example.com/avatar.png',
    });

  const createInput = (suffix: string): CompleteGoogleOAuthRegistrationDto => ({
    username: `google_${suffix}`,
    phone: `09${suffix.replace(/\D/gu, '')}`.padEnd(10, '0').slice(0, 10),
  });

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
      'GoogleOAuthRegistrationUserIntegration',
      UserSchema.clone(),
    );
    grantModel = connection.model<GoogleOAuthContinuationGrant>(
      'GoogleOAuthRegistrationGrantIntegration',
      GoogleOAuthContinuationGrantSchema.clone(),
    );
    identityModel = connection.model<OAuthIdentity>(
      'GoogleOAuthRegistrationIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );
    sessionModel = connection.model<AuthSession>(
      'GoogleOAuthRegistrationSessionIntegration',
      AuthSessionSchema.clone(),
    );

    await Promise.all([
      userModel.syncIndexes(),
      grantModel.syncIndexes(),
      identityModel.syncIndexes(),
      sessionModel.syncIndexes(),
    ]);

    const values: Record<string, string> = {
      GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS: '600',
      JWT_SECRET: 'integration-access-secret-that-is-at-least-32-characters',
      JWT_REFRESH_SECRET:
        'integration-refresh-secret-that-is-different-and-long',
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_SECONDS: '604800',
      REFRESH_TOKEN_HASH_ROUNDS: '8',
    };

    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    continuationService = new GoogleOAuthContinuationGrantService(
      grantModel,
      configService,
    );
    identityService = new OAuthIdentityService(identityModel);
    authSessionService = new AuthSessionService(
      sessionModel,
      userModel,
      new JwtService(),
      configService,
      connection,
      {} as AuthAuditService,
    );
    registrationService = new GoogleOAuthRegistrationService(
      connection,
      userModel,
      continuationService,
      identityService,
      authSessionService,
    );
  });

  beforeEach(async () => {
    sequence += 1;

    await Promise.all([
      sessionModel.deleteMany({}),
      identityModel.deleteMany({}),
      grantModel.deleteMany({}),
      userModel.deleteMany({}),
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

  it('creates a passwordless user, identity and session atomically', async () => {
    const suffix = `${process.pid}${sequence}`;
    const email = `google-${suffix}@example.com`;
    const issued = await issueGrant(email, `google-subject-${suffix}`);

    const result = await registrationService.completeRegistration(
      issued.rawGrant,
      createInput(suffix),
      { userAgent: 'Integration Chrome' },
    );

    const rawUser = await userModel.collection.findOne({ email });

    expect(rawUser).not.toBeNull();
    expect(rawUser).not.toHaveProperty('password');
    expect(result).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user: {
        email,
        id: expect.stringMatching(/^usr_/u),
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawUser?._id.toString());

    const [identityCount, sessionCount, storedGrant] = await Promise.all([
      identityModel.countDocuments({
        userId: rawUser?._id,
        provider: OAuthProvider.GOOGLE,
      }),
      sessionModel.countDocuments({
        userId: rawUser?._id,
      }),
      grantModel
        .findOne({
          grantHash: digest(issued.rawGrant),
        })
        .lean()
        .exec(),
    ]);

    expect(identityCount).toBe(1);
    expect(sessionCount).toBe(1);
    expect(storedGrant?.consumedAt).toBeInstanceOf(Date);
  });

  it('rolls back grant when the Google subject is already linked', async () => {
    const suffix = `${process.pid}${sequence}`;
    const providerAccountId = `linked-subject-${suffix}`;
    const existingUser = await userModel.create({
      publicId: `usr_linked_${suffix}`,
      username: `linked_${suffix}`,
      fullname: 'Existing Google User',
      phone: `08${suffix.replace(/\D/gu, '')}`.padEnd(10, '0').slice(0, 10),
      email: `linked-${suffix}@example.com`,
      status: 'active',
      isDeleted: false,
    });

    await identityModel.create({
      userId: existingUser._id,
      provider: OAuthProvider.GOOGLE,
      providerAccountId,
    });

    const registrationEmail = `new-${suffix}@example.com`;
    const issued = await issueGrant(registrationEmail, providerAccountId);

    await expect(
      registrationService.completeRegistration(
        issued.rawGrant,
        createInput(suffix),
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const [newUserCount, sessionCount, storedGrant] = await Promise.all([
      userModel.countDocuments({ email: registrationEmail }),
      sessionModel.countDocuments({}),
      grantModel
        .findOne({ grantHash: digest(issued.rawGrant) })
        .lean()
        .exec(),
    ]);

    expect(newUserCount).toBe(0);
    expect(sessionCount).toBe(0);
    expect(storedGrant?.consumedAt).toBeNull();
  });

  it('rolls back user and grant when identity persistence fails', async () => {
    const suffix = `${process.pid}${sequence}`;
    const email = `identity-failure-${suffix}@example.com`;
    const issued = await issueGrant(
      email,
      `identity-failure-subject-${suffix}`,
    );
    const identityError = new Error('forced identity persistence failure');

    jest
      .spyOn(identityModel, 'insertMany')
      .mockRejectedValueOnce(identityError as never);

    await expect(
      registrationService.completeRegistration(
        issued.rawGrant,
        createInput(suffix),
        {},
      ),
    ).rejects.toBe(identityError);

    const [userCount, identityCount, sessionCount, storedGrant] =
      await Promise.all([
        userModel.countDocuments({ email }),
        identityModel.countDocuments({}),
        sessionModel.countDocuments({}),
        grantModel
          .findOne({
            grantHash: digest(issued.rawGrant),
          })
          .lean()
          .exec(),
      ]);

    expect(userCount).toBe(0);
    expect(identityCount).toBe(0);
    expect(sessionCount).toBe(0);
    expect(storedGrant?.consumedAt).toBeNull();
  });

  it('rolls back user, identity and grant when session creation fails', async () => {
    const suffix = `${process.pid}${sequence}`;
    const email = `session-failure-${suffix}@example.com`;
    const issued = await issueGrant(email, `session-failure-subject-${suffix}`);
    const sessionError = new Error('forced session persistence failure');

    jest
      .spyOn(authSessionService, 'createSession')
      .mockRejectedValueOnce(sessionError);

    await expect(
      registrationService.completeRegistration(
        issued.rawGrant,
        createInput(suffix),
        {},
      ),
    ).rejects.toBe(sessionError);

    const [userCount, identityCount, sessionCount, storedGrant] =
      await Promise.all([
        userModel.countDocuments({ email }),
        identityModel.countDocuments({}),
        sessionModel.countDocuments({}),
        grantModel
          .findOne({
            grantHash: digest(issued.rawGrant),
          })
          .lean()
          .exec(),
      ]);

    expect(userCount).toBe(0);
    expect(identityCount).toBe(0);
    expect(sessionCount).toBe(0);
    expect(storedGrant?.consumedAt).toBeNull();
  });

  it('allows only one registration for the same raw grant', async () => {
    const suffix = `${process.pid}${sequence}`;
    const email = `same-grant-${suffix}@example.com`;
    const issued = await issueGrant(email, `same-grant-subject-${suffix}`);
    const input = createInput(suffix);

    const outcomes = await Promise.allSettled([
      registrationService.completeRegistration(issued.rawGrant, input, {}),
      registrationService.completeRegistration(issued.rawGrant, input, {}),
    ]);

    const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
    const rejected = outcomes.filter(({ status }) => status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    if (rejected[0]?.status !== 'rejected') {
      throw new Error('Expected one rejected registration');
    }

    expect(rejected[0].reason).toBeInstanceOf(UnauthorizedException);
    expect(await userModel.countDocuments({ email })).toBe(1);
    expect(await identityModel.countDocuments({})).toBe(1);
    expect(await sessionModel.countDocuments({})).toBe(1);
  });

  it('allows only one of two grants competing for the same unique fields', async () => {
    const suffix = `${process.pid}${sequence}`;
    const first = await issueGrant(
      `race-first-${suffix}@example.com`,
      `race-first-subject-${suffix}`,
    );
    const second = await issueGrant(
      `race-second-${suffix}@example.com`,
      `race-second-subject-${suffix}`,
    );
    const input = createInput(suffix);

    const outcomes = await Promise.allSettled([
      registrationService.completeRegistration(first.rawGrant, input, {}),
      registrationService.completeRegistration(second.rawGrant, input, {}),
    ]);

    const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
    const rejected = outcomes.filter(({ status }) => status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    if (rejected[0]?.status !== 'rejected') {
      throw new Error('Expected one rejected registration');
    }

    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(
      await userModel.countDocuments({
        username: input.username,
      }),
    ).toBe(1);
    expect(await identityModel.countDocuments({})).toBe(1);
    expect(await sessionModel.countDocuments({})).toBe(1);
  });
});
