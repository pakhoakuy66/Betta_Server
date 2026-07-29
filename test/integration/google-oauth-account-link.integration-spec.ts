import { createHash, randomUUID } from 'node:crypto';
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
import type { CommandStartedEvent } from 'mongodb';
import { type Connection, createConnection, type Model, Types } from 'mongoose';

import { GoogleOAuthAccountLinkUnavailableException } from '../../src/modules/auth/exceptions/google-oauth-account-link-unavailable.exception';
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
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantSchema,
} from '../../src/modules/auth/schemas/google-oauth-continuation-grant.schema';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
  OAuthProvider,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { GoogleOAuthAccountLinkService } from '../../src/modules/auth/services/google-oauth-account-link.service';
import { GoogleOAuthContinuationGrantService } from '../../src/modules/auth/services/google-oauth-continuation-grant.service';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';
import {
  USER_STATUS,
  User,
  UserSchema,
} from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_link_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

type CreatedUser = {
  _id: Types.ObjectId;
  email: string;
};

type Gate = {
  promise: Promise<void>;
  open: () => void;
};

const createGate = (): Gate => {
  let open = (): void => undefined;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    promise,
    open,
  };
};

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

jest.setTimeout(120_000);

describe('Google OAuth account-link MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let grantModel: Model<GoogleOAuthContinuationGrant>;
  let identityModel: Model<OAuthIdentity>;
  let auditModel: Model<AuthAuditEvent>;

  let continuationService: GoogleOAuthContinuationGrantService;
  let identityService: OAuthIdentityService;
  let auditService: AuthAuditService;
  let linkService: GoogleOAuthAccountLinkService;

  let fixtureSequence = 0;

  const createUser = async (): Promise<CreatedUser> => {
    fixtureSequence += 1;

    const suffix =
      `${process.pid}${fixtureSequence}` +
      randomUUID().replace(/-/gu, '').slice(0, 8);

    const userId = new Types.ObjectId();
    const email = `oauth-link-${suffix}@example.com`;

    await userModel.create({
      _id: userId,
      publicId: `usr_${suffix}`,
      username: `oauth_link_${suffix}`,
      fullname: 'OAuth Link User',
      phone: `09${suffix.replace(/\D/gu, '')}`.padEnd(10, '0').slice(0, 10),
      email,
      password: 'PasswordHashForIntegrationTest',
      isDeleted: false,
      status: USER_STATUS.ACTIVE,
      lockedUntil: null,
    });

    return {
      _id: userId,
      email,
    };
  };

  const issueLinkGrant = (user: CreatedUser, providerAccountId: string) =>
    continuationService.issueLinkGrant({
      targetUserId: user._id,
      providerAccountId,
      email: user.email,
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
      monitorCommands: true,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    userModel = connection.model<User>(
      'GoogleOAuthLinkUserIntegration',
      UserSchema.clone(),
    );

    grantModel = connection.model<GoogleOAuthContinuationGrant>(
      'GoogleOAuthLinkGrantIntegration',
      GoogleOAuthContinuationGrantSchema.clone(),
    );

    identityModel = connection.model<OAuthIdentity>(
      'GoogleOAuthLinkIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );

    auditModel = connection.model<AuthAuditEvent>(
      'GoogleOAuthLinkAuditIntegration',
      AuthAuditEventSchema.clone(),
    );

    await Promise.all([
      userModel.syncIndexes(),
      grantModel.syncIndexes(),
      identityModel.syncIndexes(),
      auditModel.syncIndexes(),
    ]);

    const configService = {
      get: jest.fn((key: string): string | undefined => {
        if (key === 'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS') {
          return '600';
        }

        if (key === 'AUTH_AUDIT_RETENTION_DAYS') {
          return '180';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    continuationService = new GoogleOAuthContinuationGrantService(
      grantModel,
      configService,
    );

    identityService = new OAuthIdentityService(identityModel);

    auditService = new AuthAuditService(auditModel, configService);

    linkService = new GoogleOAuthAccountLinkService(
      connection,
      userModel,
      continuationService,
      identityService,
      auditService,
    );
  });

  beforeEach(async () => {
    fixtureSequence = 0;

    await Promise.all([
      identityModel.deleteMany({}),
      grantModel.deleteMany({}),
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

  it('links identity, consumes grant and writes audit atomically', async () => {
    const user = await createUser();

    const issued = await issueLinkGrant(user, 'successful-link-subject');

    const baselineUpdatedAt = new Date(Date.now() - 60_000);

    await userModel.updateOne(
      {
        _id: user._id,
      },
      {
        $set: {
          updatedAt: baselineUpdatedAt,
        },
      },
      {
        timestamps: false,
      },
    );

    await expect(
      linkService.linkGoogleAccount(issued.rawGrant, user._id),
    ).resolves.toBeUndefined();

    const [grant, identity, audit, afterLink] = await Promise.all([
      grantModel
        .findOne({
          grantHash: digest(issued.rawGrant),
        })
        .lean()
        .exec(),

      identityModel
        .findOne({
          userId: user._id,
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'successful-link-subject',
        })
        .lean()
        .exec(),

      auditModel
        .findOne({
          eventCode: AuthAuditEventCode.OAUTH_LINKED,
          targetUserId: user._id,
        })
        .lean()
        .exec(),

      userModel
        .findById(user._id)
        .select('updatedAt')
        .lean<{
          updatedAt: Date;
        } | null>()
        .exec(),
    ]);

    expect(grant?.consumedAt).toBeInstanceOf(Date);
    expect(identity).not.toBeNull();

    expect(audit).toMatchObject({
      eventCode: AuthAuditEventCode.OAUTH_LINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
      targetUserId: user._id,
      actorUserId: user._id,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
    });

    expect(afterLink).not.toBeNull();

    if (!afterLink) {
      throw new Error('Expected user timestamp record');
    }

    expect(afterLink.updatedAt.getTime()).toBeGreaterThan(
      baselineUpdatedAt.getTime(),
    );
  });

  it('rolls back grant, identity and write barrier when audit fails', async () => {
    const user = await createUser();

    const issued = await issueLinkGrant(user, 'audit-rollback-subject');

    const beforeLink = await userModel
      .findById(user._id)
      .select('updatedAt')
      .lean<{
        updatedAt: Date;
      } | null>()
      .exec();

    const auditError = new Error('forced audit failure');

    jest.spyOn(auditService, 'record').mockRejectedValueOnce(auditError);

    await expect(
      linkService.linkGoogleAccount(issued.rawGrant, user._id),
    ).rejects.toBe(auditError);

    const [grant, identityCount, auditCount, afterLink] = await Promise.all([
      grantModel
        .findOne({
          grantHash: digest(issued.rawGrant),
        })
        .lean()
        .exec(),

      identityModel.countDocuments({
        userId: user._id,
      }),

      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_LINKED,
      }),

      userModel
        .findById(user._id)
        .select('updatedAt')
        .lean<{
          updatedAt: Date;
        } | null>()
        .exec(),
    ]);

    expect(grant?.consumedAt).toBeNull();
    expect(identityCount).toBe(0);
    expect(auditCount).toBe(0);

    expect(beforeLink).not.toBeNull();
    expect(afterLink).not.toBeNull();

    if (!beforeLink || !afterLink) {
      throw new Error('Expected user timestamp records');
    }

    expect(afterLink.updatedAt.getTime()).toBe(beforeLink.updatedAt.getTime());
  });

  it('rejects link after ban commits and rolls back grant consume', async () => {
    const user = await createUser();

    const issued = await issueLinkGrant(user, 'banned-before-link-subject');

    await userModel.updateOne(
      {
        _id: user._id,
      },
      {
        $set: {
          status: USER_STATUS.BANNED,
        },
      },
    );

    await expect(
      linkService.linkGoogleAccount(issued.rawGrant, user._id),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountLinkUnavailableException);

    const [grant, identityCount, auditCount] = await Promise.all([
      grantModel
        .findOne({
          grantHash: digest(issued.rawGrant),
        })
        .lean()
        .exec(),

      identityModel.countDocuments({
        userId: user._id,
      }),

      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_LINKED,
      }),
    ]);

    expect(grant?.consumedAt).toBeNull();
    expect(identityCount).toBe(0);
    expect(auditCount).toBe(0);
  });

  it('serializes ban behind an in-flight account link write barrier', async () => {
    const user = await createUser();

    const issued = await issueLinkGrant(user, 'write-barrier-subject');

    const linkReachedBarrier = createGate();
    const releaseLink = createGate();
    const banCommandStarted = createGate();

    /*
     * Dùng một service instance độc lập để gọi implementation thật.
     * Instance đang bị spy chỉ đóng vai trò barrier điều phối race.
     */
    const conflictReader = new OAuthIdentityService(identityModel);

    jest
      .spyOn(identityService, 'hasGoogleLinkConflict')
      .mockImplementationOnce(
        async (userId, providerAccountId, mongoSession) => {
          linkReachedBarrier.open();

          await releaseLink.promise;

          return conflictReader.hasGoogleLinkConflict(
            userId,
            providerAccountId,
            mongoSession,
          );
        },
      );

    const commandListener = (event: CommandStartedEvent): void => {
      if (event.commandName === 'update') {
        banCommandStarted.open();
      }
    };

    connection.getClient().on('commandStarted', commandListener);

    const linkPromise = linkService.linkGoogleAccount(
      issued.rawGrant,
      user._id,
    );

    await linkReachedBarrier.promise;

    let banSettled = false;

    const banPromise = userModel
      .updateOne(
        {
          _id: user._id,
        },
        {
          $set: {
            status: USER_STATUS.BANNED,
          },
        },
      )
      .exec()
      .then(
        (result) => {
          banSettled = true;
          return result;
        },
        (error: unknown) => {
          banSettled = true;
          throw error;
        },
      );

    try {
      await banCommandStarted.promise;
      await Promise.resolve();

      expect(banSettled).toBe(false);
    } finally {
      releaseLink.open();
      connection.getClient().off('commandStarted', commandListener);
    }

    await expect(linkPromise).resolves.toBeUndefined();
    await expect(banPromise).resolves.toBeDefined();

    const [userAfterRace, identityCount, auditCount] = await Promise.all([
      userModel
        .findById(user._id)
        .select('status')
        .lean<{
          status: string;
        } | null>()
        .exec(),

      identityModel.countDocuments({
        userId: user._id,
        providerAccountId: 'write-barrier-subject',
      }),

      auditModel.countDocuments({
        targetUserId: user._id,
        eventCode: AuthAuditEventCode.OAUTH_LINKED,
      }),
    ]);

    expect(userAfterRace?.status).toBe(USER_STATUS.BANNED);
    expect(identityCount).toBe(1);
    expect(auditCount).toBe(1);
  });
});
