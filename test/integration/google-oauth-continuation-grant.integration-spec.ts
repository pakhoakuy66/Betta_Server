import { randomUUID } from 'node:crypto';
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
  GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION,
  GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH,
  type GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantPurpose,
  GoogleOAuthContinuationGrantSchema,
} from '../../src/modules/auth/schemas/google-oauth-continuation-grant.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_goauth_grant_it_';
const MAX_DATABASE_NAME_BYTES = 42;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const HIDDEN_FIELDS = [
  'grantHash',
  'purpose',
  'providerAccountId',
  'email',
  'targetUserId',
  'fullname',
  'avatar',
] as const;

jest.setTimeout(90_000);

describe('Google OAuth continuation grant MongoDB integration', () => {
  let connection: Connection;
  let grantModel: Model<GoogleOAuthContinuationGrant>;

  const createPayload = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    grantHash: 'a'.repeat(GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH),
    purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
    providerAccountId: 'Google-Subject-123',
    email: ' User@Example.com ',
    targetUserId: null,
    fullname: 'Betta User',
    avatar: 'https://example.com/avatar.jpg',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  });

  const persist = async (overrides: Record<string, unknown> = {}) => {
    const document = new grantModel(createPayload(overrides));

    return document.save();
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

    grantModel = connection.model<GoogleOAuthContinuationGrant>(
      'GoogleOAuthContinuationGrantIntegration',
      GoogleOAuthContinuationGrantSchema.clone(),
    );

    await grantModel.syncIndexes();
  });

  beforeEach(async () => {
    await grantModel.deleteMany({});
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

  it('creates the exact collection and indexes', async () => {
    expect(grantModel.collection.collectionName).toBe(
      GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION,
    );

    const indexes = await grantModel.collection.listIndexes().toArray();

    expect(indexes).toHaveLength(3);

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'grantHash_1',
          key: { grantHash: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: 'expiresAt_ttl',
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it('hides grant bindings by default', async () => {
    await persist();

    const hidden = await grantModel.findOne({}).lean().exec();

    for (const field of HIDDEN_FIELDS) {
      expect(hidden).not.toHaveProperty(field);
    }

    const explicit = await grantModel
      .findOne({})
      .select(HIDDEN_FIELDS.map((field) => `+${field}`).join(' '))
      .lean()
      .exec();

    expect(explicit).toMatchObject({
      grantHash: 'a'.repeat(43),
      purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      providerAccountId: 'Google-Subject-123',
      email: 'user@example.com',
      targetUserId: null,
      fullname: 'Betta User',
      avatar: 'https://example.com/avatar.jpg',
    });
  });

  it('enforces unique grant hashes', async () => {
    await persist();

    await expect(
      persist({
        providerAccountId: 'Different-Google-Subject',
      }),
    ).rejects.toMatchObject({
      code: 11000,
    });

    await expect(grantModel.countDocuments({})).resolves.toBe(1);
  });

  it('persists a minimal link grant', async () => {
    const targetUserId = new Types.ObjectId();

    const created = await persist({
      purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      targetUserId,
      fullname: null,
      avatar: null,
    });

    const stored = await grantModel
      .findById(created._id)
      .select('+purpose +targetUserId +fullname +avatar')
      .lean()
      .exec();

    expect(stored).toMatchObject({
      purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      fullname: null,
      avatar: null,
    });

    expect(stored?.targetUserId?.toString()).toBe(targetUserId.toString());
  });

  it('rejects invalid purpose-specific bindings', async () => {
    await expect(
      persist({
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        targetUserId: null,
        fullname: null,
        avatar: null,
      }),
    ).rejects.toThrow();

    await expect(
      persist({
        targetUserId: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
  });

  it('rejects immutable grant binding updates', async () => {
    const originalTargetUserId = new Types.ObjectId();

    const created = await persist({
      purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      targetUserId: originalTargetUserId,
      fullname: null,
      avatar: null,
    });

    await expect(
      grantModel.updateOne(
        { _id: created._id },
        {
          $set: {
            providerAccountId: 'Different-Google-Subject',
            targetUserId: new Types.ObjectId(),
          },
        },
        {
          runValidators: true,
          strict: 'throw',
        },
      ),
    ).rejects.toMatchObject({
      name: 'StrictModeError',
    });

    const stored = await grantModel
      .findById(created._id)
      .select('+providerAccountId +targetUserId')
      .lean()
      .exec();

    expect(stored?.providerAccountId).toBe('Google-Subject-123');

    expect(stored?.targetUserId?.toString()).toBe(
      originalTargetUserId.toString(),
    );

    expect(stored?.consumedAt).toBeNull();
  });

  it('allows consumedAt transition without changing binding', async () => {
    const created = await persist();
    const consumedAt = new Date();

    const result = await grantModel.updateOne(
      {
        _id: created._id,
        consumedAt: null,
        expiresAt: {
          $gt: consumedAt,
        },
      },
      {
        $set: {
          consumedAt,
        },
      },
      {
        runValidators: true,
      },
    );

    expect(result.modifiedCount).toBe(1);

    const stored = await grantModel.findById(created._id).lean().exec();

    expect(stored?.consumedAt).toEqual(consumedAt);
  });

  it('blocks replaceOne without changing the grant', async () => {
    const created = await persist();

    await expect(
      grantModel
        .replaceOne(
          { _id: created._id },
          createPayload({
            providerAccountId: 'Different-Google-Subject',
          }),
        )
        .exec(),
    ).rejects.toThrow('Google OAuth continuation grants cannot be replaced');

    const stored = await grantModel
      .findById(created._id)
      .select('+providerAccountId')
      .lean()
      .exec();

    expect(stored?.providerAccountId).toBe('Google-Subject-123');
  });

  it('blocks findOneAndReplace without changing the grant', async () => {
    const created = await persist();

    await expect(
      grantModel
        .findOneAndReplace(
          { _id: created._id },
          createPayload({
            providerAccountId: 'Different-Google-Subject',
          }),
        )
        .exec(),
    ).rejects.toThrow('Google OAuth continuation grants cannot be replaced');

    const stored = await grantModel
      .findById(created._id)
      .select('+providerAccountId')
      .lean()
      .exec();

    expect(stored?.providerAccountId).toBe('Google-Subject-123');
  });

  it('blocks bulkWrite without deleting the grant', async () => {
    const created = await persist();

    await expect(
      grantModel.bulkWrite([
        {
          deleteOne: {
            filter: {
              _id: created._id,
            },
          },
        },
      ]),
    ).rejects.toThrow(
      'Google OAuth continuation grant bulk writes are not allowed',
    );

    await expect(
      grantModel.exists({
        _id: created._id,
      }),
    ).resolves.not.toBeNull();
  });

  it.each([
    'accessToken',
    'refreshToken',
    'idToken',
    'authorizationCode',
    'rawGrantToken',
    'password',
    'otp',
  ])('rejects forbidden field %s', async (field) => {
    await expect(
      persist({
        [field]: 'secret-value',
      }),
    ).rejects.toThrow();
  });
});
