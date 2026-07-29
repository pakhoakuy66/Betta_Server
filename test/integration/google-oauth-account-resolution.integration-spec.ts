import { randomUUID } from 'node:crypto';
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, createConnection, type Model, Types } from 'mongoose';

import {
  GOOGLE_OAUTH_INTERNAL_USER_ID,
  GoogleOAuthAccountResolutionStatus,
} from '../../src/modules/auth/interfaces/google-oauth-account-resolution.interface';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { GoogleOAuthAccountResolverService } from '../../src/modules/auth/services/google-oauth-account-resolver.service';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';
import {
  USER_STATUS,
  User,
  UserSchema,
  type UserStatus,
} from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_res_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

type UserFixtureOverrides = {
  email?: string;
  isDeleted?: boolean;
  status?: UserStatus;
  lockedUntil?: Date | null;
};

type CreatedUser = {
  _id: Types.ObjectId;
  email: string;
};

jest.setTimeout(90_000);

describe('Google OAuth account resolution MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let identityModel: Model<OAuthIdentity>;
  let identityService: OAuthIdentityService;
  let resolver: GoogleOAuthAccountResolverService;

  let fixtureSequence = 0;

  const createUser = async (
    overrides: UserFixtureOverrides = {},
  ): Promise<CreatedUser> => {
    fixtureSequence += 1;

    const suffix =
      `${process.pid}${fixtureSequence}` +
      randomUUID().replace(/-/gu, '').slice(0, 8);

    const userId = new Types.ObjectId();

    const email = overrides.email ?? `oauth-resolution-${suffix}@example.com`;

    await userModel.create({
      _id: userId,
      publicId: `usr_${suffix}`,
      username: `oauth_user_${suffix}`,
      fullname: 'OAuth Resolution User',
      phone: `09${suffix.replace(/\D/gu, '').padEnd(8, '0').slice(0, 8)}`,
      email,
      password: 'PasswordHashForIntegrationTest',
      isDeleted: overrides.isDeleted ?? false,
      status: overrides.status ?? USER_STATUS.ACTIVE,
      lockedUntil: overrides.lockedUntil ?? null,
    });

    return {
      _id: userId,
      email: email.trim().toLowerCase(),
    };
  };

  const linkGoogle = async (
    userId: Types.ObjectId,
    providerAccountId: string,
  ): Promise<void> => {
    await connection.transaction(async (session) => {
      await identityService.createGoogleIdentity(
        userId,
        providerAccountId,
        session,
      );
    });
  };

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
      'GoogleOAuthResolutionUserIntegration',
      UserSchema.clone(),
    );

    identityModel = connection.model<OAuthIdentity>(
      'GoogleOAuthResolutionIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );

    await Promise.all([userModel.syncIndexes(), identityModel.syncIndexes()]);

    identityService = new OAuthIdentityService(identityModel);

    resolver = new GoogleOAuthAccountResolverService(
      userModel,
      identityService,
    );
  });

  beforeEach(async () => {
    fixtureSequence = 0;

    await Promise.all([identityModel.deleteMany({}), userModel.deleteMany({})]);
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

  it('resolves an active linked Google account', async () => {
    const user = await createUser();

    await linkGoogle(user._id, 'linked-google-subject');

    const result = await resolver.resolve({
      providerAccountId: 'linked-google-subject',
      email: user.email,
      fullname: 'Linked User',
      avatar: null,
    });

    expect(result).toEqual({
      status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
      [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
    });

    expect(JSON.stringify(result)).not.toContain(user._id.toString());
  });

  it('normalizes email and preserves the exact internal account id', async () => {
    const user = await createUser({
      email: 'mixed.case@example.com',
    });

    const result = await resolver.resolve({
      providerAccountId: 'unlinked-mixed-case-subject',
      email: ' MIXED.CASE@EXAMPLE.COM ',
      fullname: 'Mixed Case User',
      avatar: null,
    });

    expect(result).toEqual({
      status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
      email: 'mixed.case@example.com',
      [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
    });

    const serialized = JSON.stringify(result);

    expect(serialized).toBe(
      JSON.stringify({
        status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
        email: 'mixed.case@example.com',
      }),
    );

    expect(serialized).not.toContain(user._id.toString());
  });

  it('returns registration-required for a new account', async () => {
    await expect(
      resolver.resolve({
        providerAccountId: 'new-google-subject',
        email: ' NEW.USER@EXAMPLE.COM ',
        fullname: 'New Google User',
        avatar: 'https://example.com/avatar.jpg',
      }),
    ).resolves.toEqual({
      status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
      profile: {
        email: 'new.user@example.com',
        fullname: 'New Google User',
        avatar: 'https://example.com/avatar.jpg',
      },
    });
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
    'rejects an unavailable existing-email account: %s',
    async (_caseName, overrides) => {
      await createUser({
        email: 'unavailable-user@example.com',
        ...overrides,
      });

      await expect(
        resolver.resolve({
          providerAccountId: 'unlinked-unavailable-subject',
          email: 'unavailable-user@example.com',
          fullname: null,
          avatar: null,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('fails closed for a dangling Google identity', async () => {
    const missingUserId = new Types.ObjectId();

    await linkGoogle(missingUserId, 'dangling-google-subject');

    await expect(
      resolver.resolve({
        providerAccountId: 'dangling-google-subject',
        email: 'dangling@example.com',
        fullname: null,
        avatar: null,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('selects hidden lockedUntil for linked account', async () => {
    const user = await createUser({
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });

    await linkGoogle(user._id, 'locked-google-subject');

    await expect(
      resolver.resolve({
        providerAccountId: 'locked-google-subject',
        email: user.email,
        fullname: null,
        avatar: null,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('selects hidden lockedUntil for existing-email account', async () => {
    await createUser({
      email: 'locked-email@example.com',
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });

    await expect(
      resolver.resolve({
        providerAccountId: 'unlinked-locked-subject',
        email: 'locked-email@example.com',
        fullname: null,
        avatar: null,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });
});
