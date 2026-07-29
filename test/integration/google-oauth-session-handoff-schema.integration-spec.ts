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
import { createConnection, type Connection, type Model } from 'mongoose';

import {
  GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_BULK_WRITE_ERROR,
  GOOGLE_OAUTH_SESSION_HANDOFF_COLLECTION,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
  GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
  GOOGLE_OAUTH_SESSION_HANDOFF_REPLACEMENT_ERROR,
  GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
} from '../../src/modules/auth/constants/google-oauth-session-handoff.constants';
import {
  type GoogleOAuthSessionHandoff,
  GoogleOAuthSessionHandoffSchema,
} from '../../src/modules/auth/schemas/google-oauth-session-handoff.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_handoff_it_';

const MAX_DATABASE_NAME_BYTES = 42;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const HIDDEN_FIELDS = [
  'handoffHash',
  'payloadVersion',
  'payloadCiphertext',
  'payloadIv',
  'payloadAuthTag',
] as const;

interface HandoffSource {
  handoffHash: string;
  payloadVersion: number;
  payloadCiphertext: string;
  payloadIv: string;
  payloadAuthTag: string;
  expiresAt: Date;
  consumedAt?: Date | null;
}

jest.setTimeout(90_000);

describe('Google OAuth session handoff MongoDB integration', () => {
  let connection: Connection;
  let model: Model<GoogleOAuthSessionHandoff>;

  const createSource = (
    overrides: Partial<HandoffSource> = {},
  ): HandoffSource => ({
    handoffHash: 'h'.repeat(GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH),
    payloadVersion: GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
    payloadCiphertext: 'Y2lwaGVydGV4dA',
    payloadIv: 'i'.repeat(GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH),
    payloadAuthTag: 't'.repeat(
      GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
    ),
    expiresAt: new Date(Date.now() + 2 * 60_000),
    ...overrides,
  });

  const persist = async (overrides: Partial<HandoffSource> = {}) => {
    const document = new model(createSource(overrides));

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

    model = connection.model<GoogleOAuthSessionHandoff>(
      'GoogleOAuthSessionHandoffIntegration',
      GoogleOAuthSessionHandoffSchema.clone(),
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

  it('creates the exact collection and indexes', async () => {
    expect(model.collection.collectionName).toBe(
      GOOGLE_OAUTH_SESSION_HANDOFF_COLLECTION,
    );

    const indexes = await model.collection.listIndexes().toArray();

    expect(indexes).toHaveLength(3);

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
          key: {
            handoffHash: 1,
          },
          unique: true,
        }),
        expect.objectContaining({
          name: GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
          key: {
            expiresAt: 1,
          },
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it('hides encrypted storage fields by default', async () => {
    const created = await persist();

    const hidden = await model.findById(created._id).lean().exec();

    expect(hidden).not.toBeNull();

    for (const field of HIDDEN_FIELDS) {
      expect(hidden).not.toHaveProperty(field);
    }

    const explicit = await model
      .findById(created._id)
      .select(HIDDEN_FIELDS.map((field) => `+${field}`).join(' '))
      .lean()
      .exec();

    expect(explicit).toMatchObject({
      handoffHash: 'h'.repeat(43),
      payloadVersion: GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
      payloadCiphertext: 'Y2lwaGVydGV4dA',
      payloadIv: 'i'.repeat(16),
      payloadAuthTag: 't'.repeat(22),
    });
  });

  it('enforces unique handoff hashes', async () => {
    await persist();

    await expect(
      persist({
        payloadCiphertext: 'ZGlmZmVyZW50',
      }),
    ).rejects.toMatchObject({
      code: 11000,
    });

    await expect(model.countDocuments({})).resolves.toBe(1);
  });

  it('rejects plaintext credential fields', async () => {
    expect(
      () =>
        new model({
          ...createSource(),
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          rawHandoff: 'raw-secret',
        }),
    ).toThrow();

    await expect(model.countDocuments({})).resolves.toBe(0);
  });

  it('rejects immutable encrypted binding updates', async () => {
    const source = createSource();
    const created = await persist(source);

    await expect(
      model.updateOne(
        {
          _id: created._id,
        },
        {
          $set: {
            handoffHash: 'z'.repeat(43),
            payloadVersion: 2,
            payloadCiphertext: 'ZGlmZmVyZW50',
            payloadIv: 'z'.repeat(16),
            payloadAuthTag: 'z'.repeat(22),
            expiresAt: new Date(Date.now() + 3_600_000),
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

    const stored = await model
      .findById(created._id)
      .select(
        '+handoffHash +payloadVersion ' +
          '+payloadCiphertext +payloadIv ' +
          '+payloadAuthTag',
      )
      .lean()
      .exec();

    expect(stored).toMatchObject({
      handoffHash: source.handoffHash,
      payloadVersion: source.payloadVersion,
      payloadCiphertext: source.payloadCiphertext,
      payloadIv: source.payloadIv,
      payloadAuthTag: source.payloadAuthTag,
    });

    expect(stored?.expiresAt).toEqual(source.expiresAt);
  });

  it('allows only the consumedAt transition', async () => {
    const created = await persist();
    const consumedAt = new Date();

    const result = await model.updateOne(
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

    const stored = await model.findById(created._id).lean().exec();

    expect(stored?.consumedAt).toEqual(consumedAt);
  });

  it('blocks replaceOne', async () => {
    const created = await persist();

    await expect(
      model
        .replaceOne(
          {
            _id: created._id,
          },
          createSource({
            payloadCiphertext: 'ZGlmZmVyZW50',
          }),
        )
        .exec(),
    ).rejects.toThrow(GOOGLE_OAUTH_SESSION_HANDOFF_REPLACEMENT_ERROR);

    await expect(
      model.exists({
        _id: created._id,
      }),
    ).resolves.not.toBeNull();
  });

  it('blocks findOneAndReplace', async () => {
    const created = await persist();

    await expect(
      model
        .findOneAndReplace(
          {
            _id: created._id,
          },
          createSource({
            payloadCiphertext: 'ZGlmZmVyZW50',
          }),
        )
        .exec(),
    ).rejects.toThrow(GOOGLE_OAUTH_SESSION_HANDOFF_REPLACEMENT_ERROR);

    await expect(
      model.exists({
        _id: created._id,
      }),
    ).resolves.not.toBeNull();
  });

  it('blocks bulkWrite', async () => {
    const created = await persist();

    await expect(
      model.bulkWrite([
        {
          deleteOne: {
            filter: {
              _id: created._id,
            },
          },
        },
      ]),
    ).rejects.toThrow(GOOGLE_OAUTH_SESSION_HANDOFF_BULK_WRITE_ERROR);

    await expect(
      model.exists({
        _id: created._id,
      }),
    ).resolves.not.toBeNull();
  });
});
