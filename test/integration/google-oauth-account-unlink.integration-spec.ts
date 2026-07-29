import { randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import * as bcrypt from 'bcrypt';
import { type Connection, createConnection, type Model, Types } from 'mongoose';

import { GoogleOAuthAccountUnlinkUnavailableException } from '../../src/modules/auth/exceptions/google-oauth-account-unlink-unavailable.exception';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../../src/modules/auth/interfaces/auth-audit.interface';
import {
  AuthAuditEvent,
  AuthAuditEventSchema,
} from '../../src/modules/auth/schemas/auth-audit-event.schema';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
  OAuthProvider,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { GoogleOAuthAccountUnlinkService } from '../../src/modules/auth/services/google-oauth-account-unlink.service';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';
import {
  USER_STATUS,
  User,
  UserSchema,
  type UserStatus,
} from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_unlink_it_';
const MAX_DATABASE_NAME_BYTES = 42;

const CURRENT_PASSWORD = 'Password@123';

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

type CreatedUser = {
  _id: Types.ObjectId;
  passwordHash?: string;
};

type CreateUserOptions = {
  hasPassword?: boolean;
  createIdentity?: boolean;
  status?: UserStatus;
  isDeleted?: boolean;
  lockedUntil?: Date | null;
};

type TimestampRecord = {
  updatedAt: Date;
};

jest.setTimeout(120_000);

describe('Google OAuth account-unlink MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let identityModel: Model<OAuthIdentity>;
  let auditModel: Model<AuthAuditEvent>;

  let identityService: OAuthIdentityService;
  let auditService: AuthAuditService;
  let unlinkService: GoogleOAuthAccountUnlinkService;

  let fixtureSequence = 0;
  let passwordHash: string;

  const createUser = async (
    options: CreateUserOptions = {},
  ): Promise<CreatedUser> => {
    fixtureSequence += 1;

    const suffix =
      `${process.pid}${fixtureSequence}` +
      randomUUID().replace(/-/gu, '').slice(0, 8);

    const userId = new Types.ObjectId();
    const hasPassword = options.hasPassword ?? true;

    await userModel.create({
      _id: userId,
      publicId: `usr_${suffix}`,
      username: `oauth_unlink_${suffix}`,
      fullname: 'OAuth Unlink User',
      phone: `09${suffix.replace(/\D/gu, '')}`.padEnd(10, '0').slice(0, 10),
      email: `oauth-unlink-${suffix}@example.com`,
      ...(hasPassword
        ? {
            password: passwordHash,
          }
        : {}),
      isDeleted: options.isDeleted ?? false,
      status: options.status ?? USER_STATUS.ACTIVE,
      lockedUntil: options.lockedUntil ?? null,
    });

    if (options.createIdentity ?? true) {
      await identityModel.create({
        userId,
        provider: OAuthProvider.GOOGLE,
        providerAccountId: `google-subject-${suffix}`,
      });
    }

    return {
      _id: userId,
      ...(hasPassword
        ? {
            passwordHash,
          }
        : {}),
    };
  };

  const setBaselineUpdatedAt = async (
    userId: Types.ObjectId,
  ): Promise<Date> => {
    const baseline = new Date(Date.now() - 60_000);

    await userModel.updateOne(
      {
        _id: userId,
      },
      {
        $set: {
          updatedAt: baseline,
        },
      },
      {
        timestamps: false,
      },
    );

    return baseline;
  };

  const readUpdatedAt = (
    userId: Types.ObjectId,
  ): Promise<TimestampRecord | null> =>
    userModel
      .findById(userId)
      .select('_id updatedAt')
      .lean<TimestampRecord | null>()
      .exec();

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
      'GoogleOAuthUnlinkUserIntegration',
      UserSchema.clone(),
    );

    identityModel = connection.model<OAuthIdentity>(
      'GoogleOAuthUnlinkIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );

    auditModel = connection.model<AuthAuditEvent>(
      'GoogleOAuthUnlinkAuditIntegration',
      AuthAuditEventSchema.clone(),
    );

    await Promise.all([
      userModel.syncIndexes(),
      identityModel.syncIndexes(),
      auditModel.syncIndexes(),
    ]);

    passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 4);

    const configService = {
      get: jest.fn((key: string): string | undefined => {
        if (key === 'AUTH_AUDIT_RETENTION_DAYS') {
          return '180';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    identityService = new OAuthIdentityService(identityModel);
    auditService = new AuthAuditService(auditModel, configService);

    unlinkService = new GoogleOAuthAccountUnlinkService(
      connection,
      userModel,
      identityService,
      auditService,
    );
  });

  beforeEach(async () => {
    fixtureSequence = 0;

    await Promise.all([
      identityModel.deleteMany({}),
      userModel.deleteMany({}),
      auditModel.collection.deleteMany({}),
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

  it('atomically unlinks Google and writes one audit', async () => {
    const user = await createUser();
    const baseline = await setBaselineUpdatedAt(user._id);

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ).resolves.toBeUndefined();

    const [identityCount, audits, userAfterUnlink] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
        provider: OAuthProvider.GOOGLE,
      }),
      auditModel
        .find({
          targetUserId: user._id,
          eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
        })
        .lean()
        .exec(),
      readUpdatedAt(user._id),
    ]);

    expect(identityCount).toBe(0);
    expect(audits).toHaveLength(1);

    expect(audits[0]).toMatchObject({
      eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_UNLINKED,
      targetUserId: user._id,
      actorUserId: user._id,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
    });

    expect(userAfterUnlink).not.toBeNull();
    expect(userAfterUnlink?.updatedAt.getTime()).toBeGreaterThan(
      baseline.getTime(),
    );
  });

  it('does not unlink the last login method', async () => {
    const user = await createUser({
      hasPassword: false,
    });

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(ConflictException);

    const [identityCount, auditCount] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
      }),
      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      }),
    ]);

    expect(identityCount).toBe(1);
    expect(auditCount).toBe(0);
  });

  it('does not mutate MongoDB when password is incorrect', async () => {
    const user = await createUser();
    const baseline = await setBaselineUpdatedAt(user._id);

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, 'Incorrect@123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const [identityCount, auditCount, userAfterFailure] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
      }),
      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      }),
      readUpdatedAt(user._id),
    ]);

    expect(identityCount).toBe(1);
    expect(auditCount).toBe(0);
    expect(userAfterFailure?.updatedAt.getTime()).toBe(baseline.getTime());
  });

  it('rolls back user claim and identity deletion when audit fails', async () => {
    const user = await createUser();
    const baseline = await setBaselineUpdatedAt(user._id);
    const auditError = new Error('forced audit failure');

    jest.spyOn(auditService, 'record').mockRejectedValueOnce(auditError);

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ).rejects.toBe(auditError);

    const [identityCount, auditCount, userAfterRollback] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
      }),
      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      }),
      readUpdatedAt(user._id),
    ]);

    expect(identityCount).toBe(1);
    expect(auditCount).toBe(0);
    expect(userAfterRollback?.updatedAt.getTime()).toBe(baseline.getTime());
  });

  it('rolls back the user claim when Google identity does not exist', async () => {
    const user = await createUser({
      createIdentity: false,
    });

    const baseline = await setBaselineUpdatedAt(user._id);

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountUnlinkUnavailableException);

    const [auditCount, userAfterRollback] = await Promise.all([
      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      }),
      readUpdatedAt(user._id),
    ]);

    expect(auditCount).toBe(0);
    expect(userAfterRollback?.updatedAt.getTime()).toBe(baseline.getTime());
  });

  it('allows exactly one concurrent unlink request to succeed', async () => {
    const user = await createUser();

    const results = await Promise.allSettled([
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(rejected[0].reason).toBeInstanceOf(
      GoogleOAuthAccountUnlinkUnavailableException,
    );

    const [identityCount, audits] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
        provider: OAuthProvider.GOOGLE,
      }),
      auditModel
        .find({
          targetUserId: user._id,
          eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
        })
        .lean()
        .exec(),
    ]);

    expect(identityCount).toBe(0);
    expect(audits).toHaveLength(1);

    expect(audits[0]).toMatchObject({
      eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      targetUserId: user._id,
      actorUserId: user._id,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
    });
  });

  it.each([
    {
      label: 'deleted',
      options: {
        isDeleted: true,
      },
    },
    {
      label: 'banned',
      options: {
        status: USER_STATUS.BANNED,
      },
    },
    {
      label: 'locked',
      options: {
        lockedUntil: new Date(Date.now() + 5 * 60_000),
      },
    },
  ])('rejects a $label account without mutation', async ({ options }) => {
    const user = await createUser(options);

    await expect(
      unlinkService.unlinkGoogleAccount(user._id, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountUnlinkUnavailableException);

    const [identityCount, auditCount] = await Promise.all([
      identityModel.countDocuments({
        userId: user._id,
      }),
      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      }),
    ]);

    expect(identityCount).toBe(1);
    expect(auditCount).toBe(0);
  });
});
