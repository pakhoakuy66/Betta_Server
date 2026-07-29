import { randomUUID } from 'node:crypto';
import {
  jest,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { type Connection, createConnection, type Model } from 'mongoose';
import {
  BASE64URL_PATTERN,
  GOOGLE_OAUTH_TRANSACTION_COLLECTION,
  GoogleOAuthTransaction,
  GoogleOAuthTransactionSchema,
} from '../../src/modules/auth/schemas/google-oauth-transaction.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_goauth_tx_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const SECRET_FIELDS = [
  'stateHash',
  'nonceHash',
  'codeVerifierCiphertext',
  'codeVerifierIv',
  'codeVerifierAuthTag',
] as const;

jest.setTimeout(60_000);

describe('Google OAuth transaction MongoDB integration', () => {
  let connection: Connection;
  let model: Model<GoogleOAuthTransaction>;

  const payload = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    stateHash: 'a'.repeat(43),
    nonceHash: 'b'.repeat(43),
    codeVerifierCiphertext: 'c'.repeat(58),
    codeVerifierIv: 'd'.repeat(16),
    codeVerifierAuthTag: 'e'.repeat(22),
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  });

  const persist = async (overrides: Record<string, unknown> = {}) => {
    const document = new model(payload(overrides));
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

    model = connection.model<GoogleOAuthTransaction>(
      'GoogleOAuthTransactionIntegration',
      GoogleOAuthTransactionSchema.clone(),
    );

    await model.syncIndexes();
  });

  beforeEach(async () => {
    await model.deleteMany({});
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

  it('declares only one stateHash schema index', () => {
    const indexes = GoogleOAuthTransactionSchema.indexes();

    const stateIndexes = indexes.filter(([keys]) =>
      Object.prototype.hasOwnProperty.call(keys, 'stateHash'),
    );

    expect(stateIndexes).toHaveLength(1);
  });

  it('creates the exact collection and indexes', async () => {
    expect(model.collection.collectionName).toBe(
      GOOGLE_OAUTH_TRANSACTION_COLLECTION,
    );

    const indexes = await model.collection.listIndexes().toArray();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'stateHash_1',
          key: { stateHash: 1 },
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

  it('hides secrets by default and allows explicit selection', async () => {
    await persist();

    const hidden = await model.findOne({}).lean().exec();

    for (const field of SECRET_FIELDS) {
      expect(hidden).not.toHaveProperty(field);
    }

    const explicit = await model
      .findOne({})
      .select(SECRET_FIELDS.map((field) => `+${field}`).join(' '))
      .lean()
      .exec();

    expect(explicit).toMatchObject({
      stateHash: 'a'.repeat(43),
      nonceHash: 'b'.repeat(43),
      codeVerifierCiphertext: 'c'.repeat(58),
      codeVerifierIv: 'd'.repeat(16),
      codeVerifierAuthTag: 'e'.repeat(22),
    });
  });

  it('defaults consumedAt to null and allows consumption', async () => {
    const created = await persist();

    expect(created.consumedAt).toBeNull();

    const consumedAt = new Date();

    await model.updateOne(
      { _id: created._id, consumedAt: null },
      { $set: { consumedAt } },
    );

    const updated = await model.findById(created._id).lean().exec();

    expect(updated?.consumedAt).toEqual(consumedAt);
  });

  it('rejects a duplicate stateHash', async () => {
    await persist();

    await expect(
      persist({
        nonceHash: 'z'.repeat(43),
      }),
    ).rejects.toMatchObject({
      code: 11000,
    });

    await expect(model.countDocuments({})).resolves.toBe(1);
  });

  it.each([
    ['stateHash', 'a'.repeat(42)],
    ['stateHash', 'a'.repeat(44)],
    ['stateHash', `${'a'.repeat(42)}=`],
    ['stateHash', `${'a'.repeat(42)}+`],
    ['stateHash', `${'a'.repeat(42)}/`],
    ['nonceHash', 'b'.repeat(42)],
    ['nonceHash', 'b'.repeat(44)],
    ['nonceHash', `${'b'.repeat(42)}=`],
    ['nonceHash', `${'b'.repeat(42)}+`],
    ['nonceHash', `${'b'.repeat(42)}/`],
  ])('rejects invalid %s', async (field, value) => {
    await expect(persist({ [field]: value })).rejects.toThrow();
  });

  it.each([58, 171])('accepts ciphertext length %i', async (length) => {
    await expect(
      persist({
        codeVerifierCiphertext: 'c'.repeat(length),
      }),
    ).resolves.toBeDefined();
  });

  it.each(['c'.repeat(57), 'c'.repeat(172), `${'c'.repeat(57)}+`])(
    'rejects invalid ciphertext',
    async (value) => {
      expect(BASE64URL_PATTERN.test(value)).toBe(!value.includes('+'));

      await expect(
        persist({
          codeVerifierCiphertext: value,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    ['codeVerifierIv', 'd'.repeat(15)],
    ['codeVerifierIv', 'd'.repeat(17)],
    ['codeVerifierIv', `${'d'.repeat(15)}+`],
    ['codeVerifierAuthTag', 'e'.repeat(21)],
    ['codeVerifierAuthTag', 'e'.repeat(23)],
    ['codeVerifierAuthTag', `${'e'.repeat(21)}+`],
  ])('rejects invalid %s', async (field, value) => {
    await expect(persist({ [field]: value })).rejects.toThrow();
  });

  it('rejects a missing expiresAt', async () => {
    await expect(persist({ expiresAt: undefined })).rejects.toThrow();
  });

  it.each([
    'state',
    'nonce',
    'codeVerifier',
    'accessToken',
    'refreshToken',
    'idToken',
    'email',
  ])('rejects forbidden field %s', async (field) => {
    await expect(persist({ [field]: 'forbidden' })).rejects.toThrow();
  });
});
