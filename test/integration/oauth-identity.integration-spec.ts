import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
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
  OAuthIdentity,
  OAuthIdentitySchema,
  OAuthProvider,
} from '../../src/modules/auth/schemas/oauth-identity.schema';
import { OAuthIdentityService } from '../../src/modules/auth/services/oauth-identity.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';

const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_oid_it_';

const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}` +
  `${process.pid}_` +
  randomUUID().replace(/-/g, '').slice(0, 12);

jest.setTimeout(60_000);

describe('Google OAuth identity MongoDB integration', () => {
  let connection: Connection;
  let identityModel: Model<OAuthIdentity>;
  let service: OAuthIdentityService;

  const createIdentity = (userId: Types.ObjectId, subject: string) =>
    connection.transaction(async (session) => {
      await service.createGoogleIdentity(userId, subject, session);
    });

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }

    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Tên integration database không an toàn');
    }

    if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
      throw new Error(
        `Tên integration database vượt quá ${MAX_DATABASE_NAME_BYTES} byte`,
      );
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    identityModel = connection.model<OAuthIdentity>(
      'OAuthIdentityIntegration',
      OAuthIdentitySchema.clone(),
    );

    await identityModel.syncIndexes();

    service = new OAuthIdentityService(identityModel);
  });

  beforeEach(async () => {
    await identityModel.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Từ chối xóa database không an toàn: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('creates exact unique identity indexes', async () => {
    const indexes = await identityModel.collection.listIndexes().toArray();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'provider_1_providerAccountId_1',
          key: {
            provider: 1,
            providerAccountId: 1,
          },
          unique: true,
        }),
        expect.objectContaining({
          name: 'userId_1_provider_1',
          key: {
            userId: 1,
            provider: 1,
          },
          unique: true,
        }),
      ]),
    );
  });

  it.each(['facebook', 'github'])(
    'rejects unsupported provider %s',
    async (provider) => {
      await expect(
        identityModel.create({
          userId: new Types.ObjectId(),
          provider: provider as OAuthProvider,
          providerAccountId: 'AbC-123',
        }),
      ).rejects.toThrow();

      expect(await identityModel.countDocuments()).toBe(0);
    },
  );

  it('hides subject by default and returns explicit selection', async () => {
    const userId = new Types.ObjectId();

    await createIdentity(userId, 'AbC-123');

    const hidden = await identityModel.findOne({ userId }).lean().exec();

    expect(hidden).not.toHaveProperty('providerAccountId');

    const explicit = await identityModel
      .findOne({ userId })
      .select('+providerAccountId')
      .lean()
      .exec();

    expect(explicit?.providerAccountId).toBe('AbC-123');
  });

  it('maps duplicate subject to conflict without extra document', async () => {
    const userA = new Types.ObjectId();

    const userB = new Types.ObjectId();

    await createIdentity(userA, 'google-sub-1');

    await expect(createIdentity(userB, 'google-sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await identityModel.countDocuments()).toBe(1);
  });

  it('maps duplicate user provider to conflict', async () => {
    const userId = new Types.ObjectId();

    await createIdentity(userId, 'google-sub-1');

    await expect(createIdentity(userId, 'google-sub-2')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(
      await identityModel.countDocuments({
        userId,
      }),
    ).toBe(1);
  });

  it('allows distinct users and subjects', async () => {
    await createIdentity(new Types.ObjectId(), 'google-sub-1');

    await createIdentity(new Types.ObjectId(), 'google-sub-2');

    expect(await identityModel.countDocuments()).toBe(2);
  });

  it('keeps subjects case-sensitive and resolves exact owners', async () => {
    const userA = new Types.ObjectId();

    const userB = new Types.ObjectId();

    await createIdentity(userA, 'AbC123');

    await createIdentity(userB, 'abc123');

    expect(await service.resolveGoogleUserId('AbC123')).toEqual(userA);

    expect(await service.resolveGoogleUserId('abc123')).toEqual(userB);
  });

  it('commits identity creation', async () => {
    const userId = new Types.ObjectId();

    await createIdentity(userId, 'commit-subject');

    expect(await service.resolveGoogleUserId('commit-subject')).toEqual(userId);
  });

  it('rolls back identity after transaction failure', async () => {
    const marker = new Error('intentional rollback');

    const userId = new Types.ObjectId();

    await expect(
      connection.transaction(async (session) => {
        await service.createGoogleIdentity(userId, 'rollback-subject', session);

        throw marker;
      }),
    ).rejects.toBe(marker);

    expect(await identityModel.countDocuments()).toBe(0);

    expect(await service.resolveGoogleUserId('rollback-subject')).toBeNull();
  });

  it('rejects malformed subjects through schema validation', async () => {
    await expect(
      identityModel.create({
        userId: new Types.ObjectId(),
        provider: OAuthProvider.GOOGLE,
        providerAccountId: 'invalid subject',
      }),
    ).rejects.toThrow();

    expect(await identityModel.countDocuments()).toBe(0);
  });

  it.each(['email', 'accessToken', 'refreshToken', 'idToken', 'tokenHash'])(
    'rejects forbidden field %s',
    async (field) => {
      const payload: Record<string, unknown> = {
        userId: new Types.ObjectId(),
        provider: OAuthProvider.GOOGLE,
        providerAccountId: 'strict-subject',
        [field]: 'forbidden',
      };

      await expect(
        identityModel.create(payload as unknown as OAuthIdentity),
      ).rejects.toThrow();

      expect(await identityModel.countDocuments()).toBe(0);
    },
  );
});
