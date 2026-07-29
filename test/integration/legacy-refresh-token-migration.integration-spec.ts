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
import { ObjectId } from 'mongodb';
import { createConnection, type Connection } from 'mongoose';
import {
  type LegacyRefreshTokenUser,
  migrateLegacyRefreshTokens,
} from '../../src/modules/auth/migrations/legacy-refresh-token.migration';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';

const DATABASE_PREFIX = 'betta_legacy_refresh_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}`;

jest.setTimeout(60_000);

describe('Legacy refreshToken migration integration', () => {
  let connection: Connection;

  beforeAll(async () => {
    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(
        `${CONFIRMATION_ENV}=${REQUIRED_CONFIRMATION} is required`,
      );
    }

    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} is required`);
    }

    connection = createConnection(uri, {
      dbName: databaseName,
    });

    await connection.asPromise();
  });

  beforeEach(async () => {
    await connection.db?.collection('users').deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Refusing unsafe database deletion: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('reports legacy fields without mutation in dry-run', async () => {
    const collection =
      connection.db!.collection<LegacyRefreshTokenUser>('users');

    const id = new ObjectId();

    await collection.insertOne({
      _id: id,
      publicId: `usr_${randomUUID()}`,
      refreshToken: 'legacy-hash',
      preservedField: 'preserved',
    });

    const result = await migrateLegacyRefreshTokens(collection, {
      execute: false,
      batchSize: 10,
      maxDocuments: 100,
    });

    expect(result).toEqual(
      expect.objectContaining({
        execute: false,
        scanned: 1,
        planned: 1,
        matched: 0,
        updated: 0,
        hasMore: false,
      }),
    );

    const stored = await collection.findOne({ _id: id });

    expect(stored?.refreshToken).toBe('legacy-hash');
    expect(stored?.preservedField).toBe('preserved');
  });

  it('removes only the legacy field and is idempotent', async () => {
    const collection =
      connection.db!.collection<LegacyRefreshTokenUser>('users');

    const id = new ObjectId();

    await collection.insertOne({
      _id: id,
      publicId: `usr_${randomUUID()}`,
      refreshToken: null,
      preservedField: 'preserved',
    });

    const firstRun = await migrateLegacyRefreshTokens(collection, {
      execute: true,
      batchSize: 10,
      maxDocuments: 100,
    });

    expect(firstRun.updated).toBe(1);
    expect(firstRun.hasMore).toBe(false);

    const stored = await collection.findOne({ _id: id });

    expect(stored).not.toHaveProperty('refreshToken');
    expect(stored?.preservedField).toBe('preserved');

    const secondRun = await migrateLegacyRefreshTokens(collection, {
      execute: true,
      batchSize: 10,
      maxDocuments: 100,
    });

    expect(secondRun.updated).toBe(0);
    expect(secondRun.hasMore).toBe(false);
  });

  it('honors maxDocuments and reports remaining work', async () => {
    const collection =
      connection.db!.collection<LegacyRefreshTokenUser>('users');

    await collection.insertMany(
      Array.from({ length: 3 }, () => ({
        _id: new ObjectId(),
        publicId: `usr_${randomUUID()}`,
        refreshToken: 'legacy-hash',
      })),
    );

    const firstRun = await migrateLegacyRefreshTokens(collection, {
      execute: true,
      batchSize: 2,
      maxDocuments: 2,
    });

    expect(firstRun.updated).toBe(2);
    expect(firstRun.hasMore).toBe(true);

    const secondRun = await migrateLegacyRefreshTokens(collection, {
      execute: true,
      batchSize: 2,
      maxDocuments: 2,
    });

    expect(secondRun.updated).toBe(1);
    expect(secondRun.hasMore).toBe(false);
  });

  it('processes multiple batches in one execution', async () => {
    const collection =
      connection.db!.collection<LegacyRefreshTokenUser>('users');

    await collection.insertMany(
      Array.from({ length: 5 }, () => ({
        _id: new ObjectId(),
        publicId: `usr_${randomUUID()}`,
        refreshToken: 'legacy-hash',
        preservedField: 'preserved',
      })),
    );

    const result = await migrateLegacyRefreshTokens(collection, {
      execute: true,
      batchSize: 2,
      maxDocuments: 10,
    });

    expect(result).toEqual(
      expect.objectContaining({
        scanned: 5,
        planned: 5,
        matched: 5,
        updated: 5,
        hasMore: false,
      }),
    );

    expect(
      await collection.countDocuments({
        refreshToken: { $exists: true },
      }),
    ).toBe(0);

    expect(
      await collection.countDocuments({
        preservedField: 'preserved',
      }),
    ).toBe(5);
  });
});
