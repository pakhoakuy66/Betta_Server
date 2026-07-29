import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Connection, createConnection, Model, Types } from 'mongoose';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service';
import {
  Block,
  BlockSchema,
} from '../../src/modules/relationshipModule/schemas/block.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../../src/modules/relationshipModule/schemas/relationship.schema';
import { BlockService } from '../../src/modules/relationshipModule/services/block.service';
import { RelationshipService } from '../../src/modules/relationshipModule/services/relationship.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

type FollowNotificationInput = {
  followerId: Types.ObjectId;
  targetUserId: Types.ObjectId;
};

type UserFixture = {
  _id: Types.ObjectId;
  publicId: string;
};

const TEST_DATABASE_PREFIX = 'betta_sg_it_';
const MAX_MONGODB_DATABASE_NAME_BYTES = 38;

const MONGODB_URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';

jest.setTimeout(60_000);

const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

if (Buffer.byteLength(databaseName, 'utf8') > MAX_MONGODB_DATABASE_NAME_BYTES) {
  throw new Error(
    `Tên integration database vượt quá ` +
      `${MAX_MONGODB_DATABASE_NAME_BYTES} byte`,
  );
}

if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
  throw new Error('Tên integration database không an toàn');
}

const getMongoDuplicateCode = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'number' ? error.code : undefined;
};

describe('Social graph MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let relationshipModel: Model<Relationship>;
  let blockModel: Model<Block>;

  let relationshipService: RelationshipService;
  let blockService: BlockService;

  const notificationsService = {
    createFollowNotification: jest.fn<
      (input: FollowNotificationInput) => Promise<void>
    >(() => Promise.resolve()),
  };

  const createUser = async (
    suffix: string,
    counters: {
      followersCount?: number;
      followingCount?: number;
    } = {},
  ): Promise<UserFixture> => {
    const document = await userModel.create({
      publicId: `usr_integration_${suffix}`,
      username: `integration_${suffix}`,
      fullname: `Integration ${suffix}`,
      phone: `0900${suffix.padStart(6, '0').slice(-6)}`,
      email: `integration_${suffix}@example.com`,
      password: 'integration-password-hash',
      status: 'active',
      isDeleted: false,
      followersCount: counters.followersCount ?? 0,
      followingCount: counters.followingCount ?? 0,
    });

    return {
      _id: document._id,
      publicId: document.publicId,
    };
  };

  beforeAll(async () => {
    const uri = process.env[MONGODB_URI_ENV];
    const confirmation = process.env[CONFIRMATION_ENV];

    if (!uri) {
      throw new Error(
        `${MONGODB_URI_ENV} chưa được cấu hình. ` +
          'Không được dùng database developer/production cho integration test.',
      );
    }

    if (confirmation !== REQUIRED_CONFIRMATION) {
      throw new Error(`${CONFIRMATION_ENV} phải bằng ${REQUIRED_CONFIRMATION}`);
    }

    const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

    if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    if (!connection.name.startsWith(TEST_DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Từ chối chạy trên database: ${connection.name}`);
    }

    userModel = connection.model<User>(User.name, UserSchema);

    relationshipModel = connection.model<Relationship>(
      Relationship.name,
      RelationshipSchema,
    );

    blockModel = connection.model<Block>(Block.name, BlockSchema);

    // Database này mới và dành riêng cho integration test.
    await Promise.all([
      userModel.syncIndexes(),
      relationshipModel.syncIndexes(),
      blockModel.syncIndexes(),
    ]);

    relationshipService = new RelationshipService(
      connection,
      relationshipModel,
      userModel,
      blockModel,
      notificationsService as unknown as NotificationsService,
    );

    blockService = new BlockService(
      connection,
      blockModel,
      relationshipModel,
      userModel,
    );
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    await Promise.all([
      relationshipModel.deleteMany({}),
      blockModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;

    if (!connection.name.startsWith(TEST_DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Từ chối xóa database không an toàn: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('creates the required unique compound indexes', async () => {
    const [relationshipIndexes, blockIndexes] = await Promise.all([
      relationshipModel.collection.indexes(),
      blockModel.collection.indexes(),
    ]);

    expect(relationshipIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: {
            followerId: 1,
            followingId: 1,
          },
          unique: true,
        }),
      ]),
    );

    expect(blockIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: {
            blockerId: 1,
            blockedId: 1,
          },
          unique: true,
        }),
      ]),
    );
  });

  it('enforces relationship and block uniqueness in MongoDB', async () => {
    const firstUser = await createUser('unique_a');
    const secondUser = await createUser('unique_b');

    await relationshipModel.create({
      followerId: firstUser._id,
      followingId: secondUser._id,
    });

    let relationshipError: unknown;

    try {
      await relationshipModel.create({
        followerId: firstUser._id,
        followingId: secondUser._id,
      });
    } catch (error: unknown) {
      relationshipError = error;
    }

    expect(getMongoDuplicateCode(relationshipError)).toBe(11000);

    await blockModel.create({
      blockerId: firstUser._id,
      blockedId: secondUser._id,
    });

    let blockError: unknown;

    try {
      await blockModel.create({
        blockerId: firstUser._id,
        blockedId: secondUser._id,
      });
    } catch (error: unknown) {
      blockError = error;
    }

    expect(getMongoDuplicateCode(blockError)).toBe(11000);
  });

  it('allows only one concurrent follow and keeps counters consistent', async () => {
    const follower = await createUser('follow_a');
    const target = await createUser('follow_b');

    const results = await Promise.allSettled([
      relationshipService.followUser(follower._id.toString(), target.publicId),
      relationshipService.followUser(follower._id.toString(), target.publicId),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const [relationshipCount, refreshedFollower, refreshedTarget] =
      await Promise.all([
        relationshipModel.countDocuments({
          followerId: follower._id,
          followingId: target._id,
        }),
        userModel.findById(follower._id).lean().exec(),
        userModel.findById(target._id).lean().exec(),
      ]);

    expect(relationshipCount).toBe(1);
    expect(refreshedFollower?.followingCount).toBe(1);
    expect(refreshedTarget?.followersCount).toBe(1);

    expect(
      results.some(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof ConflictException,
      ),
    ).toBe(true);
  });

  it('paginates followers and following without duplicates or omissions', async () => {
    const owner = await createUser('pagination_owner');
    const pageSize = 20;
    const totalUsers = 25;

    const [followers, following] = await Promise.all([
      Promise.all(
        Array.from({ length: totalUsers }, (_, index) =>
          createUser(`pagination_follower_${index}`),
        ),
      ),
      Promise.all(
        Array.from({ length: totalUsers }, (_, index) =>
          createUser(`pagination_following_${index}`),
        ),
      ),
    ]);

    await relationshipModel.insertMany([
      ...followers.map((follower) => ({
        followerId: follower._id,
        followingId: owner._id,
      })),
      ...following.map((target) => ({
        followerId: owner._id,
        followingId: target._id,
      })),
    ]);

    const [
      followersPageOne,
      followersPageTwo,
      followingPageOne,
      followingPageTwo,
    ] = await Promise.all([
      relationshipService.getFollowers(
        owner.publicId,
        owner._id.toString(),
        1,
        pageSize,
      ),
      relationshipService.getFollowers(
        owner.publicId,
        owner._id.toString(),
        2,
        pageSize,
      ),
      relationshipService.getFollowing(
        owner.publicId,
        owner._id.toString(),
        1,
        pageSize,
      ),
      relationshipService.getFollowing(
        owner.publicId,
        owner._id.toString(),
        2,
        pageSize,
      ),
    ]);

    expect(followersPageOne.pagination).toEqual({
      total: totalUsers,
      page: 1,
      limit: pageSize,
      totalPages: 2,
      hasMore: true,
    });

    expect(followersPageTwo.pagination).toEqual({
      total: totalUsers,
      page: 2,
      limit: pageSize,
      totalPages: 2,
      hasMore: false,
    });

    expect(followingPageOne.pagination).toEqual({
      total: totalUsers,
      page: 1,
      limit: pageSize,
      totalPages: 2,
      hasMore: true,
    });

    expect(followingPageTwo.pagination).toEqual({
      total: totalUsers,
      page: 2,
      limit: pageSize,
      totalPages: 2,
      hasMore: false,
    });

    expect(followersPageOne.data).toHaveLength(pageSize);
    expect(followersPageTwo.data).toHaveLength(totalUsers - pageSize);
    expect(followingPageOne.data).toHaveLength(pageSize);
    expect(followingPageTwo.data).toHaveLength(totalUsers - pageSize);

    const returnedFollowerIds = [
      ...followersPageOne.data,
      ...followersPageTwo.data,
    ].map((user) => user.publicId);

    const returnedFollowingIds = [
      ...followingPageOne.data,
      ...followingPageTwo.data,
    ].map((user) => user.publicId);

    expect(new Set(returnedFollowerIds).size).toBe(totalUsers);
    expect(new Set(returnedFollowingIds).size).toBe(totalUsers);

    expect([...returnedFollowerIds].sort()).toEqual(
      followers.map((user) => user.publicId).sort(),
    );

    expect([...returnedFollowingIds].sort()).toEqual(
      following.map((user) => user.publicId).sort(),
    );
  });

  it('blocks transactionally, removes both follow directions and updates counters', async () => {
    const firstUser = await createUser('block_a', {
      followersCount: 1,
      followingCount: 1,
    });

    const secondUser = await createUser('block_b', {
      followersCount: 1,
      followingCount: 1,
    });

    await relationshipModel.create([
      {
        followerId: firstUser._id,
        followingId: secondUser._id,
      },
      {
        followerId: secondUser._id,
        followingId: firstUser._id,
      },
    ]);

    await expect(
      blockService.blockUser(firstUser._id.toString(), secondUser.publicId),
    ).resolves.toEqual({
      success: true,
      message: 'Đã chặn người dùng thành công',
    });

    const [blockCount, relationshipCount, refreshedFirst, refreshedSecond] =
      await Promise.all([
        blockModel.countDocuments({
          blockerId: firstUser._id,
          blockedId: secondUser._id,
        }),
        relationshipModel.countDocuments({
          $or: [
            {
              followerId: firstUser._id,
              followingId: secondUser._id,
            },
            {
              followerId: secondUser._id,
              followingId: firstUser._id,
            },
          ],
        }),
        userModel.findById(firstUser._id).lean().exec(),
        userModel.findById(secondUser._id).lean().exec(),
      ]);

    expect(blockCount).toBe(1);
    expect(relationshipCount).toBe(0);

    expect(refreshedFirst).toEqual(
      expect.objectContaining({
        followersCount: 0,
        followingCount: 0,
      }),
    );

    expect(refreshedSecond).toEqual(
      expect.objectContaining({
        followersCount: 0,
        followingCount: 0,
      }),
    );

    await expect(
      relationshipService.followUser(
        firstUser._id.toString(),
        secondUser.publicId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows only one concurrent block and creates no duplicate document', async () => {
    const blocker = await createUser('concurrent_block_a');
    const blocked = await createUser('concurrent_block_b');

    const results = await Promise.allSettled([
      blockService.blockUser(blocker._id.toString(), blocked.publicId),
      blockService.blockUser(blocker._id.toString(), blocked.publicId),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    expect(
      await blockModel.countDocuments({
        blockerId: blocker._id,
        blockedId: blocked._id,
      }),
    ).toBe(1);
  });
});
