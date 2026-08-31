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
import { ExpiredPostCleanupService } from '../../src/modules/cron/services/expired-post-cleanup.service';
import {
  Post,
  PostCleanupStatus,
  PostSchema,
} from '../../src/modules/posts/schemas/post.schema';
import {
  Reaction,
  ReactionSchema,
  ReactionType,
} from '../../src/modules/reactions/schemas/reaction.schema';
import {
  ReactionCleanupCursor,
  ReactionCleanupCursorSchema,
} from '../../src/modules/reactions/schemas/reaction-cleanup-cursor.schema';
import {
  REACTION_CLEANUP_PRODUCTION_CONFIRMATION,
  ReactionCleanupService,
} from '../../src/modules/reactions/services/reaction-cleanup.service';
import {
  WeeklyRecapRun,
  WeeklyRecapRunSchema,
  WeeklyRecapRunStatus,
} from '../../src/modules/recap/schemas/weekly-recap-run.schema';
import { RECAP_TIMEZONE } from '../../src/modules/recap/utils/recap-week.util';
import { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const MONGODB_URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';

const TEST_DATABASE_PREFIX = 'betta_clean_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const CLEANUP_NOW = new Date('2026-07-15T05:00:00.000Z');
const WEEK_START = new Date('2026-06-28T17:00:00.000Z');
const WEEK_END = new Date('2026-07-05T17:00:00.000Z');
const REACTION_AT = new Date('2026-07-01T05:00:00.000Z');

const POST_IDS = {
  expired: 'post_23456789ABCD',
  live: 'post_23456789ABCE',
  failed: 'post_23456789ABCF',
  concurrent: 'post_23456789ABCG',
  locked: 'post_23456789ABCH',
  reactionExpired: 'post_23456789ABCJ',
  reactionLive: 'post_23456789ABCK',
} as const;

const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

type DeleteImagesOptions = {
  throwOnError?: boolean;
};

type PostOptions = {
  images?: Array<{
    url: string;
    publicId: string;
  }>;
  cleanupStatus?: PostCleanupStatus;
  cleanupLockedUntil?: Date | null;
  cleanupAttempts?: number;
};

type ReactionScenario = {
  expiredReactionId: Types.ObjectId;
  liveReactionId: Types.ObjectId;
  orphanReactionId: Types.ObjectId;
};

jest.setTimeout(60_000);

if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
  throw new Error('Tên cleanup integration database vượt giới hạn an toàn');
}

if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
  throw new Error('Tên cleanup integration database không an toàn');
}

describe('Cleanup MongoDB integration', () => {
  let connection: Connection;

  let userModel: Model<User>;
  let postModel: Model<Post>;
  let reactionModel: Model<Reaction>;
  let weeklyRecapRunModel: Model<WeeklyRecapRun>;
  let cursorModel: Model<ReactionCleanupCursor>;

  let expiredPostCleanupService: ExpiredPostCleanupService;
  let reactionCleanupService: ReactionCleanupService;
  let userSequence = 0;

  const deleteImagesMock =
    jest.fn<
      (publicIds: string[], options?: DeleteImagesOptions) => Promise<void>
    >();

  const uploadsService = {
    deleteImages: deleteImagesMock,
  };

  const createUser = async (label: string, postsCount = 0): Promise<User> => {
    userSequence += 1;

    return userModel.create({
      publicId: `usr_cleanup_it_${label}`,
      username: `cleanup_it_${label}`,
      fullname: `Cleanup Integration ${label}`,
      phone: `08${userSequence.toString().padStart(8, '0')}`,
      email: `cleanup_it_${label}@example.com`,
      password: 'integration-password-hash',
      status: 'active',
      isDeleted: false,
      postsCount,
    });
  };

  const createPost = async (
    authorId: Types.ObjectId,
    publicId: string,
    expireAt: Date,
    options: PostOptions = {},
  ): Promise<Post> =>
    postModel.create({
      publicId,
      authorId,
      content: 'Cleanup integration post',
      images: options.images ?? [],
      likeCount: 0,
      shareCount: 0,
      expireAt,
      isDeletedByAdmin: false,
      cleanupStatus: options.cleanupStatus ?? PostCleanupStatus.PENDING,
      cleanupLockedUntil: options.cleanupLockedUntil ?? null,
      cleanupAttempts: options.cleanupAttempts ?? 0,
    });

  const createCompletedRecapRun = async (): Promise<WeeklyRecapRun> =>
    weeklyRecapRunModel.create({
      year: 2026,
      weekNumber: 27,
      weekKey: '2026-06-29',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      timezone: RECAP_TIMEZONE,
      status: WeeklyRecapRunStatus.COMPLETED,
      completedAt: new Date('2026-07-06T00:00:00.000Z'),
    });

  const createReactionScenario = async (): Promise<ReactionScenario> => {
    const author = await createUser('reaction_author');

    const expiredPost = await createPost(
      author._id,
      POST_IDS.reactionExpired,
      new Date('2026-07-10T00:00:00.000Z'),
    );

    const livePost = await createPost(
      author._id,
      POST_IDS.reactionLive,
      new Date('2026-07-20T00:00:00.000Z'),
    );

    await createCompletedRecapRun();

    const orphanPostId = new Types.ObjectId();

    // Chủ động cấp ID để fixture không phụ thuộc overload trả về
    // của Model.create() khi tạo một mảng document.
    const expiredReactionId = new Types.ObjectId();
    const liveReactionId = new Types.ObjectId();
    const orphanReactionId = new Types.ObjectId();

    await reactionModel.collection.insertMany([
      {
        _id: expiredReactionId,
        userId: new Types.ObjectId(),
        postId: expiredPost._id,
        postOwnerId: author._id,
        emojiType: ReactionType.HEART,
        createdAt: REACTION_AT,
        updatedAt: REACTION_AT,
      },
      {
        _id: liveReactionId,
        userId: new Types.ObjectId(),
        postId: livePost._id,
        postOwnerId: author._id,
        emojiType: ReactionType.HEART,
        createdAt: REACTION_AT,
        updatedAt: REACTION_AT,
      },
      {
        _id: orphanReactionId,
        userId: new Types.ObjectId(),
        postId: orphanPostId,
        postOwnerId: author._id,
        emojiType: ReactionType.HEART,
        createdAt: REACTION_AT,
        updatedAt: REACTION_AT,
      },
    ]);

    return {
      expiredReactionId,
      liveReactionId,
      orphanReactionId,
    };
  };

  beforeAll(async () => {
    const uri = process.env[MONGODB_URI_ENV];
    const confirmation = process.env[CONFIRMATION_ENV];

    if (!uri) {
      throw new Error(
        `${MONGODB_URI_ENV} chưa được cấu hình. ` +
          'Không dùng database developer/production.',
      );
    }

    if (confirmation !== REQUIRED_CONFIRMATION) {
      throw new Error(`${CONFIRMATION_ENV} phải bằng ` + REQUIRED_CONFIRMATION);
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

    postModel = connection.model<Post>(Post.name, PostSchema);

    reactionModel = connection.model<Reaction>(Reaction.name, ReactionSchema);

    weeklyRecapRunModel = connection.model<WeeklyRecapRun>(
      WeeklyRecapRun.name,
      WeeklyRecapRunSchema,
    );

    cursorModel = connection.model<ReactionCleanupCursor>(
      ReactionCleanupCursor.name,
      ReactionCleanupCursorSchema,
    );

    await Promise.all([
      userModel.syncIndexes(),
      postModel.syncIndexes(),
      reactionModel.syncIndexes(),
      weeklyRecapRunModel.syncIndexes(),
      cursorModel.syncIndexes(),
    ]);

    expiredPostCleanupService = new ExpiredPostCleanupService(
      postModel,
      userModel,
      uploadsService as unknown as UploadsService,
    );

    reactionCleanupService = new ReactionCleanupService(
      connection,
      reactionModel,
      postModel,
      weeklyRecapRunModel,
      cursorModel,
    );
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    userSequence = 0;

    deleteImagesMock.mockReset();
    deleteImagesMock.mockImplementation(() => Promise.resolve());

    await Promise.all([
      cursorModel.deleteMany({}),
      reactionModel.deleteMany({}),
      weeklyRecapRunModel.deleteMany({}),
      postModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;

    if (!connection.name.startsWith(TEST_DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Từ chối xóa database không an toàn: ` + connection.name);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('deletes only expired posts and is idempotent', async () => {
    const author = await createUser('expired_post_author', 2);

    await Promise.all([
      createPost(author._id, POST_IDS.expired, new Date(Date.now() - 60_000), {
        images: [
          {
            url: 'https://example.com/expired.jpg',
            publicId: 'betta/posts/expired-integration',
          },
        ],
      }),
      createPost(
        author._id,
        POST_IDS.live,
        new Date(Date.now() + 60 * 60 * 1000),
      ),
    ]);

    const firstResult = await expiredPostCleanupService.cleanupExpiredPosts();

    expect(firstResult).toEqual({
      processed: 1,
      deleted: 1,
      failed: 0,
    });

    const [expiredPost, livePost, refreshedAuthor] = await Promise.all([
      postModel.findOne({
        publicId: POST_IDS.expired,
      }),
      postModel.findOne({
        publicId: POST_IDS.live,
      }),
      userModel.findById(author._id),
    ]);

    expect(expiredPost).toBeNull();
    expect(livePost).not.toBeNull();
    expect(refreshedAuthor?.postsCount).toBe(1);

    expect(deleteImagesMock).toHaveBeenCalledWith(
      ['betta/posts/expired-integration'],
      {
        throwOnError: true,
      },
    );

    await expect(
      expiredPostCleanupService.cleanupExpiredPosts(),
    ).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
  });

  it('moves an ambiguous physical deletion failure to manual review without retry', async () => {
    const author = await createUser('failed_post_author', 1);

    await createPost(
      author._id,
      POST_IDS.failed,
      new Date(Date.now() - 60_000),
      {
        images: [
          {
            url: 'https://example.com/failed.jpg',
            publicId: 'betta/posts/failed-integration',
          },
        ],
      },
    );

    deleteImagesMock.mockImplementation(() =>
      Promise.reject(new Error('Cloudinary unavailable')),
    );

    const result = await expiredPostCleanupService.cleanupExpiredPosts();

    expect(result).toEqual({
      processed: 1,
      deleted: 0,
      failed: 1,
    });

    const [retainedPost, refreshedAuthor] = await Promise.all([
      postModel
        .findOne({
          publicId: POST_IDS.failed,
        })
        .select('+cleanupDestructiveStartedAt'),
      userModel.findById(author._id),
    ]);

    expect(retainedPost).toEqual(
      expect.objectContaining({
        cleanupStatus: PostCleanupStatus.MANUAL_REVIEW,
        cleanupLockedUntil: null,
        cleanupAttempts: 1,
        cleanupDestructiveStartedAt: expect.any(Date),
      }),
    );

    expect(retainedPost?.cleanupLastError).toContain('Cloudinary unavailable');

    expect(refreshedAuthor?.postsCount).toBe(1);
    expect(deleteImagesMock).toHaveBeenCalledTimes(1);

    await expect(
      expiredPostCleanupService.cleanupExpiredPosts(),
    ).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
  });

  it('allows only one worker to claim an expired post', async () => {
    const author = await createUser('concurrent_post_author', 1);

    await createPost(
      author._id,
      POST_IDS.concurrent,
      new Date(Date.now() - 60_000),
    );

    const secondWorker = new ExpiredPostCleanupService(
      postModel,
      userModel,
      uploadsService as unknown as UploadsService,
    );

    const [firstResult, secondResult] = await Promise.all([
      expiredPostCleanupService.cleanupExpiredPosts(),
      secondWorker.cleanupExpiredPosts(),
    ]);

    expect(firstResult.processed + secondResult.processed).toBe(1);

    expect(firstResult.deleted + secondResult.deleted).toBe(1);

    expect(firstResult.failed + secondResult.failed).toBe(0);

    expect(
      await postModel.countDocuments({
        publicId: POST_IDS.concurrent,
      }),
    ).toBe(0);

    expect((await userModel.findById(author._id))?.postsCount).toBe(0);
  });

  it('does not claim a fresh lock but reclaims an expired lock', async () => {
    const author = await createUser('locked_post_author', 1);

    const post = await createPost(
      author._id,
      POST_IDS.locked,
      new Date(Date.now() - 60_000),
      {
        cleanupStatus: PostCleanupStatus.PROCESSING,
        cleanupLockedUntil: new Date(Date.now() + 60 * 60 * 1000),
        cleanupAttempts: 1,
      },
    );

    await expect(
      expiredPostCleanupService.cleanupExpiredPosts(),
    ).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });

    expect(await postModel.findById(post._id)).not.toBeNull();

    await postModel.updateOne(
      { _id: post._id },
      {
        $set: {
          cleanupLockedUntil: new Date(Date.now() - 60_000),
        },
      },
    );

    await expect(
      expiredPostCleanupService.cleanupExpiredPosts(),
    ).resolves.toEqual({
      processed: 1,
      deleted: 1,
      failed: 0,
    });

    expect(await postModel.findById(post._id)).toBeNull();
  });

  it('keeps reaction dry-run read-only', async () => {
    await createReactionScenario();

    const beforeCount = await reactionModel.countDocuments({});

    const result = await reactionCleanupService.cleanupEligibleReactions({
      execute: false,
      now: CLEANUP_NOW,
      batchSize: 10,
      maxWeeks: 5,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        execute: false,
        scannedWeeks: 1,
        fullyScannedWeeks: 1,
        weeksWithCandidates: 1,
        observedEligible: 2,
        planned: 2,
        processed: 0,
        deleted: 0,
        skipped: 0,
        failedWeeks: 0,
        cursorAdvancedTo: null,
      }),
    );

    expect(await reactionModel.countDocuments({})).toBe(beforeCount);

    expect(await cursorModel.countDocuments({})).toBe(0);
  });

  it('deletes only orphan/expired reactions and is idempotent', async () => {
    const fixture = await createReactionScenario();

    const firstResult = await reactionCleanupService.cleanupEligibleReactions({
      execute: true,
      now: CLEANUP_NOW,
      batchSize: 10,
      maxWeeks: 5,
      productionConfirmation: REACTION_CLEANUP_PRODUCTION_CONFIRMATION,
    });

    expect(firstResult).toEqual(
      expect.objectContaining({
        success: true,
        execute: true,
        processed: 2,
        deleted: 2,
        skipped: 0,
        failedWeeks: 0,
        cursorAdvancedTo: '2026-06-29',
      }),
    );

    expect(
      await reactionModel.exists({
        _id: fixture.expiredReactionId,
      }),
    ).toBeNull();

    expect(
      await reactionModel.exists({
        _id: fixture.orphanReactionId,
      }),
    ).toBeNull();

    expect(
      await reactionModel.exists({
        _id: fixture.liveReactionId,
      }),
    ).not.toBeNull();

    const cursor = await cursorModel.findOne({
      jobName: 'reaction-cleanup',
    });

    expect(cursor).toEqual(
      expect.objectContaining({
        lastWeekStart: WEEK_START,
      }),
    );

    const secondResult = await reactionCleanupService.cleanupEligibleReactions({
      execute: true,
      now: CLEANUP_NOW,
      batchSize: 10,
      maxWeeks: 5,
      productionConfirmation: REACTION_CLEANUP_PRODUCTION_CONFIRMATION,
    });

    expect(secondResult.success).toBe(true);
    expect(secondResult.deleted).toBe(0);
    expect(await reactionModel.countDocuments({})).toBe(1);
  });

  it('counts malformed postId and skips deletion', async () => {
    const author = await createUser('malformed_reaction_author');

    await createCompletedRecapRun();

    const malformedReactionId = new Types.ObjectId();

    await reactionModel.collection.insertOne({
      _id: malformedReactionId,
      userId: new Types.ObjectId(),
      postId: 'malformed-post-id',
      postOwnerId: author._id,
      emojiType: ReactionType.HEART,
      createdAt: REACTION_AT,
      updatedAt: REACTION_AT,
    });

    const result = await reactionCleanupService.cleanupEligibleReactions({
      execute: true,
      now: CLEANUP_NOW,
      batchSize: 10,
      maxWeeks: 5,
      productionConfirmation: REACTION_CLEANUP_PRODUCTION_CONFIRMATION,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        observedEligible: 1,
        malformedPostIds: 1,
        malformedReactionIds: 0,
        planned: 0,
        processed: 1,
        deleted: 0,
        skipped: 1,
        failedWeeks: 0,
      }),
    );

    expect(
      await reactionModel.collection.findOne({
        _id: malformedReactionId,
      }),
    ).not.toBeNull();
  });
});
