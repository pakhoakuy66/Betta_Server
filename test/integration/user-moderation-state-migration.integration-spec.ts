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
  USER_MODERATION_MIGRATABLE_FIELDS,
  USER_DELETION_ORIGIN_INDEX_NAME,
  USER_RESTRICTION_INDEX_NAME,
  UserDeletionOrigin,
  UserRestrictionType,
} from '../../src/modules/users/constants/user-moderation.constants';
import {
  migrateUserModerationState,
  type UserModerationMigrationDocument,
} from '../../src/modules/users/migrations/user-moderation-state.migration';
import { USER_STATUS } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';
const DATABASE_PREFIX = 'betta_um01_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}`;
const migrationNow = new Date('2026-08-15T00:00:00.000Z');

jest.setTimeout(60_000);

describe('User moderation state migration MongoDB integration', () => {
  let connection: Connection;

  beforeAll(async () => {
    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(
        `${CONFIRMATION_ENV}=${REQUIRED_CONFIRMATION} is required`,
      );
    }
    const uri = process.env[URI_ENV];
    if (!uri) throw new Error(`${URI_ENV} is required`);
    connection = createConnection(uri, { dbName: databaseName });
    await connection.asPromise();
  });

  beforeEach(async () => {
    await connection.db?.collection('users').deleteMany({});
  });

  afterAll(async () => {
    if (!connection) return;
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

  const collection = () =>
    connection.db!.collection<UserModerationMigrationDocument>('users');

  const insertLegacyUser = async (
    overrides: Record<string, unknown> = {},
  ): Promise<ObjectId> => {
    const _id = new ObjectId();
    await collection().insertOne({
      _id,
      publicId: `usr_${randomUUID()}`,
      username: `user_${randomUUID()}`,
      status: USER_STATUS.ACTIVE,
      isDeleted: false,
      preservedField: 'preserved',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-06-01T00:00:00.000Z'),
      ...overrides,
    });
    return _id;
  };

  it('reports forward work without mutating a legacy User', async () => {
    const id = await insertLegacyUser();
    const result = await migrateUserModerationState(collection(), {
      execute: false,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 100,
      now: migrationNow,
    });
    expect(result).toMatchObject({
      execute: false,
      scanned: 1,
      planned: 1,
      updated: 0,
      hasMore: false,
    });
    expect(await collection().findOne({ _id: id })).not.toHaveProperty(
      'moderationMigration',
    );
  });

  it('maps typed restriction and deletion state while preserving compatibility fields', async () => {
    const activeId = await insertLegacyUser();
    const bannedId = await insertLegacyUser({ status: USER_STATUS.BANNED });
    const deletedId = await insertLegacyUser({
      status: USER_STATUS.REPORTED,
      isDeleted: true,
    });
    const result = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 2,
      maxDocuments: 10,
      now: migrationNow,
    });
    expect(result).toMatchObject({
      scanned: 3,
      planned: 3,
      matched: 3,
      updated: 3,
      hasMore: false,
    });
    const active = await collection().findOne({ _id: activeId });
    const banned = await collection().findOne({ _id: bannedId });
    const deleted = await collection().findOne({ _id: deletedId });
    expect(active).toMatchObject({
      status: USER_STATUS.ACTIVE,
      restriction: null,
      deletionOrigin: null,
      version: 0,
      authzVersion: 0,
      preservedField: 'preserved',
    });
    expect(banned).toMatchObject({
      status: USER_STATUS.BANNED,
      restriction: {
        type: UserRestrictionType.INDEFINITE_BAN,
        expiresAt: null,
        publicReasonCode: 'legacy_indefinite_ban',
      },
    });
    expect(deleted).toMatchObject({
      status: USER_STATUS.REPORTED,
      isDeleted: true,
      deletionOrigin: UserDeletionOrigin.USER_SELF_DELETED,
    });
    expect(banned?.restriction).not.toHaveProperty('rawReason');
    const indexes = (await collection().listIndexes().toArray()) as Array<
      Record<string, unknown>
    >;
    const moderationIndexNames = new Set<string>([
      USER_RESTRICTION_INDEX_NAME,
      USER_DELETION_ORIGIN_INDEX_NAME,
    ]);
    expect(
      indexes.filter(
        (index) =>
          typeof index.name === 'string' &&
          moderationIndexNames.has(index.name),
      ),
    ).toHaveLength(2);
    for (const index of indexes) {
      expect(index).not.toHaveProperty('expireAfterSeconds');
    }
  });

  it('is idempotent and resumes bounded batches', async () => {
    await Promise.all(Array.from({ length: 3 }, () => insertLegacyUser()));
    const first = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 1,
      maxDocuments: 2,
      now: migrationNow,
    });
    expect(first).toMatchObject({ updated: 2, hasMore: true });
    const second = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 1,
      maxDocuments: 2,
      now: migrationNow,
    });
    expect(second).toMatchObject({ updated: 1, hasMore: false });
    const third = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 10,
      now: migrationNow,
    });
    expect(third).toMatchObject({ scanned: 0, updated: 0, hasMore: false });
  });

  it('rolls back only fields owned by this migration', async () => {
    const id = await insertLegacyUser({ version: 0 });
    await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 10,
      now: migrationNow,
    });
    const migrated = await collection().findOne({ _id: id });
    expect(migrated?.moderationMigration?.ownedFields).not.toContain('version');
    const result = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'rollback',
      batchSize: 10,
      maxDocuments: 10,
      now: migrationNow,
    });
    expect(result).toMatchObject({ updated: 1, hasMore: false });
    const restored = await collection().findOne({ _id: id });
    expect(restored).toMatchObject({
      status: USER_STATUS.ACTIVE,
      version: 0,
      preservedField: 'preserved',
    });
    expect(restored).not.toHaveProperty('restriction');
    expect(restored).not.toHaveProperty('moderationMigration');
  });

  it('fails closed when runtime moderation versions changed after migration', async () => {
    const id = await insertLegacyUser();
    await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 10,
      now: migrationNow,
    });
    await collection().updateOne(
      { _id: id },
      { $set: { version: 1, authzVersion: 1 } },
    );
    const result = await migrateUserModerationState(collection(), {
      execute: true,
      direction: 'rollback',
      batchSize: 10,
      maxDocuments: 10,
      now: migrationNow,
    });
    expect(result).toMatchObject({
      scanned: 1,
      planned: 0,
      updated: 0,
      skippedConflicts: 1,
      hasMore: true,
    });
    const stored = await collection().findOne({ _id: id });
    expect(stored?.moderationMigration?.ownedFields).toEqual(
      USER_MODERATION_MIGRATABLE_FIELDS.filter(
        (field) => field !== 'isDeleted',
      ),
    );
    expect(stored?.isDeleted).toBe(false);
  });
});
