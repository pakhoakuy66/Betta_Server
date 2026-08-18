import { describe, expect, it, jest } from '@jest/globals';
import { type Collection, ObjectId } from 'mongodb';
import {
  USER_MODERATION_MIGRATABLE_FIELDS,
  USER_MODERATION_SCHEMA_VERSION,
  USER_DELETION_ORIGIN_INDEX_NAME,
  USER_RESTRICTION_INDEX_NAME,
  UserDeletionOrigin,
  UserRestrictionType,
} from '../constants/user-moderation.constants';
import { USER_STATUS } from '../schemas/user.schema';
import {
  buildLegacyRestrictionSupportReference,
  buildUserModerationForwardPlan,
  migrateUserModerationState,
  USER_MODERATION_INDEXES,
  type UserModerationMigrationDocument,
} from './user-moderation-state.migration';

const now = new Date('2026-08-15T00:00:00.000Z');

const legacyUser = (
  overrides: Partial<UserModerationMigrationDocument> = {},
): UserModerationMigrationDocument => ({
  _id: new ObjectId('65f000000000000000000001'),
  publicId: 'user_public_001',
  status: USER_STATUS.ACTIVE,
  isDeleted: false,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-06-01T00:00:00.000Z'),
  ...overrides,
});

describe('User moderation state migration planner', () => {
  it('defines bounded partial indexes without TTL deletion', () => {
    expect(USER_MODERATION_INDEXES.map((index) => index.name)).toEqual([
      USER_RESTRICTION_INDEX_NAME,
      USER_DELETION_ORIGIN_INDEX_NAME,
    ]);
    for (const index of USER_MODERATION_INDEXES) {
      expect(index).toHaveProperty('partialFilterExpression');
      expect(index).not.toHaveProperty('expireAfterSeconds');
    }
  });

  it('creates indexes only during confirmed forward execution', async () => {
    const createIndexes = jest.fn((indexes: unknown[]) => {
      void indexes;
      return Promise.resolve([] as string[]);
    });
    const toArray = jest.fn(() =>
      Promise.resolve([] as UserModerationMigrationDocument[]),
    );
    const limit = jest.fn(() => ({ toArray }));
    const sort = jest.fn(() => ({ limit }));
    const find = jest.fn(() => ({ sort }));
    const findOne = jest.fn(() => Promise.resolve(null));
    const collection = {
      createIndexes,
      find,
      findOne,
    } as unknown as Collection<UserModerationMigrationDocument>;

    await migrateUserModerationState(collection, {
      execute: false,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 10,
      now,
    });
    expect(createIndexes).not.toHaveBeenCalled();

    await migrateUserModerationState(collection, {
      execute: true,
      direction: 'forward',
      batchSize: 10,
      maxDocuments: 10,
      now,
    });
    expect(createIndexes).toHaveBeenCalledWith([...USER_MODERATION_INDEXES]);
  });

  it('adds an explicit unrestricted compatibility state', () => {
    const document = legacyUser();
    delete document.isDeleted;
    const plan = buildUserModerationForwardPlan(document, now);
    expect(plan.set).toMatchObject({
      isDeleted: false,
      restriction: null,
      deletionOrigin: null,
      restorableUntil: null,
      version: 0,
      authzVersion: 0,
      moderationSchemaVersion: USER_MODERATION_SCHEMA_VERSION,
    });
    expect(plan.ownedFields).toEqual(USER_MODERATION_MIGRATABLE_FIELDS);
    expect(plan.filter).toMatchObject({
      _id: document._id,
      isDeleted: { $exists: false },
    });
  });

  it('maps a legacy ban to a deterministic indefinite restriction', () => {
    const first = buildUserModerationForwardPlan(
      legacyUser({ status: USER_STATUS.BANNED }),
      now,
    );
    const second = buildUserModerationForwardPlan(
      legacyUser({ status: USER_STATUS.BANNED }),
      new Date('2026-08-16T00:00:00.000Z'),
    );
    expect(first.set.restriction).toEqual({
      type: UserRestrictionType.INDEFINITE_BAN,
      effectiveAt: new Date('2025-06-01T00:00:00.000Z'),
      expiresAt: null,
      supportReference:
        buildLegacyRestrictionSupportReference('user_public_001'),
      publicReasonCode: 'legacy_indefinite_ban',
    });
    expect(second.set.restriction).toEqual(first.set.restriction);
  });

  it('maps legacy self-deletion without changing legacy status', () => {
    const plan = buildUserModerationForwardPlan(
      legacyUser({ isDeleted: true, status: USER_STATUS.REPORTED }),
      now,
    );
    expect(plan.set.deletionOrigin).toBe(UserDeletionOrigin.USER_SELF_DELETED);
    expect(plan.set.restriction).toBeNull();
    expect(plan.set).not.toHaveProperty('status');
  });

  it('preserves fields already owned by newer code', () => {
    const plan = buildUserModerationForwardPlan(
      legacyUser({
        restriction: {
          type: UserRestrictionType.TEMPORARY_SUSPENSION,
          effectiveAt: now,
          expiresAt: new Date('2026-08-16T00:00:00.000Z'),
          supportReference: 'sup_existing_reference',
          publicReasonCode: 'manual_review',
        },
        version: 7,
      }),
      now,
    );
    expect(plan.set).not.toHaveProperty('restriction');
    expect(plan.set).not.toHaveProperty('version');
    expect(plan.ownedFields).not.toContain('restriction');
    expect(plan.ownedFields).not.toContain('version');
  });

  it.each([
    { status: 'unknown' },
    { isDeleted: 'yes' },
    { version: -1 },
    { authzVersion: 1.2 },
    { moderationSchemaVersion: 99 },
    {
      moderationMigration: {
        version: 1,
        migratedAt: now,
        ownedFields: ['version'],
      },
    },
  ])('rejects malformed or already migrated input %#', (overrides) => {
    expect(() =>
      buildUserModerationForwardPlan(
        legacyUser(overrides as Partial<UserModerationMigrationDocument>),
        now,
      ),
    ).toThrow();
  });
});
