import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { createConnection, type Connection, Types } from 'mongoose';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import { buildEligibleUserMatch } from '../../src/modules/users/policies/user-eligibility.policy';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const NOW = new Date('2026-08-20T10:00:00.000Z');
const databaseName = `betta_eligibility_it_${process.pid}_${randomBytes(4).toString('hex')}`;

jest.setTimeout(60_000);

describe('User eligibility MongoDB integration', () => {
  let connection: Connection;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if ([process.env.DATABASE_URL, process.env.MONGODB_URI].includes(uri)) {
      throw new Error('Integration URI không được trùng runtime URI');
    }

    connection = createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    });
    await connection.asPromise();
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.dropDatabase();
    await connection.close();
  });

  it('allows only active users with no restriction or an expired suspension', async () => {
    const users = connection.collection('users');
    const rows = [
      {
        _id: new Types.ObjectId(),
        marker: 'active',
        isDeleted: false,
        status: 'active',
        restriction: null,
      },
      {
        _id: new Types.ObjectId(),
        marker: 'expired',
        isDeleted: false,
        status: 'active',
        restriction: {
          type: UserRestrictionType.TEMPORARY_SUSPENSION,
          expiresAt: NOW,
        },
      },
      {
        _id: new Types.ObjectId(),
        marker: 'suspended',
        isDeleted: false,
        status: 'active',
        restriction: {
          type: UserRestrictionType.TEMPORARY_SUSPENSION,
          expiresAt: new Date(NOW.getTime() + 1),
        },
      },
      {
        _id: new Types.ObjectId(),
        marker: 'banned',
        isDeleted: false,
        status: 'active',
        restriction: {
          type: UserRestrictionType.INDEFINITE_BAN,
          expiresAt: null,
        },
      },
      {
        _id: new Types.ObjectId(),
        marker: 'malformed',
        isDeleted: false,
        status: 'active',
        restriction: { type: 'UNKNOWN', expiresAt: null },
      },
      {
        _id: new Types.ObjectId(),
        marker: 'deleted',
        isDeleted: true,
        status: 'active',
        restriction: null,
      },
    ];
    await users.insertMany(rows);

    const eligible = await users
      .find(buildEligibleUserMatch(NOW))
      .sort({ marker: 1 })
      .project({ _id: 0, marker: 1 })
      .toArray();

    expect(eligible).toEqual([{ marker: 'active' }, { marker: 'expired' }]);
  });

  it('applies the same policy to joined relationship users', async () => {
    const users = connection.collection('users');
    const relationships = connection.collection('relationships');
    const activeId = new Types.ObjectId();
    const bannedId = new Types.ObjectId();
    const ownerId = new Types.ObjectId();

    await users.insertMany([
      {
        _id: activeId,
        isDeleted: false,
        status: 'active',
        restriction: null,
      },
      {
        _id: bannedId,
        isDeleted: false,
        status: 'active',
        restriction: {
          type: UserRestrictionType.INDEFINITE_BAN,
          expiresAt: null,
        },
      },
    ]);
    await relationships.insertMany([
      { followerId: activeId, followingId: ownerId },
      { followerId: bannedId, followingId: ownerId },
    ]);

    const visible = await relationships
      .aggregate([
        { $match: { followingId: ownerId } },
        {
          $lookup: {
            from: 'users',
            localField: 'followerId',
            foreignField: '_id',
            as: 'follower',
          },
        },
        { $unwind: '$follower' },
        { $match: buildEligibleUserMatch(NOW, 'follower') },
        { $project: { _id: 0, followerId: 1 } },
      ])
      .toArray();

    expect(visible).toEqual([{ followerId: activeId }]);
  });
});
