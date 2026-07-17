import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { Connection, createConnection, Model, Types } from 'mongoose';
import {
  Notification,
  NotificationSchema,
  NotificationType,
} from '../../src/modules/notifications/schemas/notifications.schema';
import {
  PostShare,
  PostShareSchema,
} from '../../src/modules/posts/schemas/post-share.schema';
import { Post, PostSchema } from '../../src/modules/posts/schemas/post.schema';
import {
  Reaction,
  ReactionSchema,
  ReactionType,
} from '../../src/modules/reactions/schemas/reaction.schema';
import {
  EngagementEvent,
  EngagementEventSchema,
  EngagementEventType,
} from '../../src/modules/recap/schemas/engagement-event.schema';
import {
  WeeklyRecap,
  WeeklyRecapSchema,
} from '../../src/modules/recap/schemas/recap.schema';
import { RECAP_TIMEZONE } from '../../src/modules/recap/utils/recap-week.util';
import {
  Block,
  BlockSchema,
} from '../../src/modules/relationshipModule/schemas/block.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../../src/modules/relationshipModule/schemas/relationship.schema';
import {
  ReportCooldown,
  ReportCooldownSchema,
} from '../../src/modules/reports/schemas/report-cooldown.schema';
import { ReportTargetType } from '../../src/modules/reports/schemas/report.schema';
import {
  StreakHistory,
  StreakHistorySchema,
} from '../../src/modules/streak/schemas/streak.schema';
import { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  User,
  UserSchema,
} from '../../src/modules/users/schemas/user.schema';
import { UsersService } from '../../src/modules/users/services/users.service';

const MONGODB_URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';

const TEST_DATABASE_PREFIX = 'betta_account_delete_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const CURRENT_PASSWORD = 'Password@123';
const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

const NOW = new Date('2026-07-15T05:00:00.000Z');
const WEEK_START = new Date('2026-07-05T17:00:00.000Z');
const WEEK_END = new Date('2026-07-12T17:00:00.000Z');

type UserOptions = {
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  avatarId?: string;
  avatar?: string;
};

jest.setTimeout(120_000);

if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
  throw new Error('Tên account deletion database vượt giới hạn an toàn');
}

if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
  throw new Error('Tên account deletion database không an toàn');
}

describe('Account deletion MongoDB integration', () => {
  let connection: Connection;

  let userModel: Model<User>;
  let relationshipModel: Model<Relationship>;
  let blockModel: Model<Block>;
  let postModel: Model<Post>;
  let reactionModel: Model<Reaction>;
  let postShareModel: Model<PostShare>;
  let notificationModel: Model<Notification>;
  let engagementEventModel: Model<EngagementEvent>;
  let weeklyRecapModel: Model<WeeklyRecap>;
  let streakHistoryModel: Model<StreakHistory>;
  let reportCooldownModel: Model<ReportCooldown>;

  let usersService: UsersService;
  let passwordHash: string;
  let userSequence = 0;
  let forceStreakDeleteFailure = false;

  const deleteImagesMock = jest.fn<(publicIds: string[]) => Promise<void>>(() =>
    Promise.resolve(),
  );

  const uploadsService = {
    deleteImages: deleteImagesMock,
  };

  const createUser = async (
    label: string,
    options: UserOptions = {},
  ): Promise<User> => {
    userSequence += 1;

    return userModel.create({
      publicId: `usr_account_it_${label}`,
      username: `account_it_${label}`,
      fullname: `Account Integration ${label}`,
      phone: `07${userSequence.toString().padStart(8, '0')}`,
      email: `account_it_${label}@example.com`,
      password: passwordHash,
      refreshToken: 'sha256-bcrypt-v1:stored-refresh-token-hash',
      avatarId: options.avatarId ?? DEFAULT_AVATAR_ID,
      avatar: options.avatar ?? DEFAULT_AVATAR_URL,
      bio: 'Integration bio',
      link: 'https://example.com',
      status: 'active',
      isDeleted: false,
      followersCount: options.followersCount ?? 0,
      followingCount: options.followingCount ?? 0,
      postsCount: options.postsCount ?? 0,
      forgotPasswordOtp: 'stored-otp-hash',
      forgotPasswordExpiry: new Date(Date.now() + 60_000),
      forgotPasswordAttempts: 1,
      failedLoginAttempts: 1,
      failedLoginWindowStartedAt: new Date(),
      lockedUntil: null,
    });
  };

  const createPost = (
    authorId: Types.ObjectId,
    publicId: string,
    likeCount: number,
    images: Array<{ url: string; publicId: string }> = [],
  ): Promise<Post> =>
    postModel.create({
      publicId,
      authorId,
      content: 'Account deletion integration post',
      images,
      likeCount,
      shareCount: 0,
      expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      isDeletedByAdmin: false,
    });

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
      throw new Error(`${CONFIRMATION_ENV} phải bằng ${REQUIRED_CONFIRMATION}`);
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
    postModel = connection.model<Post>(Post.name, PostSchema);
    reactionModel = connection.model<Reaction>(Reaction.name, ReactionSchema);
    postShareModel = connection.model<PostShare>(
      PostShare.name,
      PostShareSchema,
    );
    notificationModel = connection.model<Notification>(
      Notification.name,
      NotificationSchema,
    );
    engagementEventModel = connection.model<EngagementEvent>(
      EngagementEvent.name,
      EngagementEventSchema,
    );
    weeklyRecapModel = connection.model<WeeklyRecap>(
      WeeklyRecap.name,
      WeeklyRecapSchema,
    );

    const integrationStreakSchema = StreakHistorySchema.clone();

    integrationStreakSchema.pre('deleteMany', function () {
      if (forceStreakDeleteFailure) {
        throw new Error('Forced account deletion transaction failure');
      }
    });

    streakHistoryModel = connection.model<StreakHistory>(
      StreakHistory.name,
      integrationStreakSchema,
    );

    reportCooldownModel = connection.model<ReportCooldown>(
      ReportCooldown.name,
      ReportCooldownSchema,
    );

    await Promise.all([
      userModel.syncIndexes(),
      relationshipModel.syncIndexes(),
      blockModel.syncIndexes(),
      postModel.syncIndexes(),
      reactionModel.syncIndexes(),
      postShareModel.syncIndexes(),
      notificationModel.syncIndexes(),
      engagementEventModel.syncIndexes(),
      weeklyRecapModel.syncIndexes(),
      streakHistoryModel.syncIndexes(),
      reportCooldownModel.syncIndexes(),
    ]);

    passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 10);

    usersService = new UsersService(
      connection,
      userModel,
      relationshipModel,
      blockModel,
      postModel,
      reactionModel,
      postShareModel,
      notificationModel,
      engagementEventModel,
      weeklyRecapModel,
      streakHistoryModel,
      reportCooldownModel,
      uploadsService as unknown as UploadsService,
    );
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    userSequence = 0;
    forceStreakDeleteFailure = false;

    deleteImagesMock.mockReset();
    deleteImagesMock.mockImplementation(() => Promise.resolve());

    await Promise.all([
      reportCooldownModel.deleteMany({}),
      streakHistoryModel.deleteMany({}),
      weeklyRecapModel.deleteMany({}),
      engagementEventModel.deleteMany({}),
      notificationModel.deleteMany({}),
      postShareModel.deleteMany({}),
      reactionModel.deleteMany({}),
      postModel.deleteMany({}),
      blockModel.deleteMany({}),
      relationshipModel.deleteMany({}),
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

  it('rejects an incorrect password without mutating MongoDB', async () => {
    const user = await createUser('wrong_password', {
      postsCount: 1,
    });

    const post = await createPost(user._id, 'post_account_wrong_password', 0);

    await expect(
      usersService.softDeleteUser(user._id.toString(), 'WrongPassword@123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const [storedUser, storedPost] = await Promise.all([
      userModel.findById(user._id).select('+refreshToken').lean().exec(),
      postModel.findById(post._id).lean().exec(),
    ]);

    expect(storedUser).toEqual(
      expect.objectContaining({
        isDeleted: false,
        refreshToken: 'sha256-bcrypt-v1:stored-refresh-token-hash',
        postsCount: 1,
      }),
    );
    expect(storedPost).not.toBeNull();
    expect(deleteImagesMock).not.toHaveBeenCalled();
  });

  it('soft-deletes the account and cleans dependent data atomically', async () => {
    const deletedUser = await createUser('deleted', {
      followersCount: 1,
      followingCount: 1,
      postsCount: 1,
      avatarId: 'betta/avatars/account-delete-avatar',
      avatar: 'https://example.com/account-delete-avatar.webp',
    });
    const follower = await createUser('follower', {
      followingCount: 1,
    });
    const following = await createUser('following', {
      followersCount: 2,
    });
    const unrelated = await createUser('unrelated', {
      followingCount: 1,
    });

    await Promise.all([
      relationshipModel.create({
        followerId: deletedUser._id,
        followingId: following._id,
      }),
      relationshipModel.create({
        followerId: follower._id,
        followingId: deletedUser._id,
      }),
      relationshipModel.create({
        followerId: unrelated._id,
        followingId: following._id,
      }),
      blockModel.create({
        blockerId: deletedUser._id,
        blockedId: following._id,
      }),
      blockModel.create({
        blockerId: unrelated._id,
        blockedId: follower._id,
      }),
    ]);

    const ownedPost = await createPost(
      deletedUser._id,
      'post_account_owned',
      1,
      [
        {
          url: 'https://example.com/owned-a.jpg',
          publicId: 'betta/posts/account-owned-a',
        },
        {
          url: 'https://example.com/owned-b.jpg',
          publicId: 'betta/posts/account-owned-b',
        },
      ],
    );

    const externalPost = await createPost(
      following._id,
      'post_account_external',
      2,
    );

    await Promise.all([
      reactionModel.create({
        userId: deletedUser._id,
        postId: externalPost._id,
        postOwnerId: following._id,
        emojiType: ReactionType.HEART,
      }),
      reactionModel.create({
        userId: follower._id,
        postId: ownedPost._id,
        postOwnerId: deletedUser._id,
        emojiType: ReactionType.HEART,
      }),
      reactionModel.create({
        userId: unrelated._id,
        postId: externalPost._id,
        postOwnerId: following._id,
        emojiType: ReactionType.HEART,
      }),
      postShareModel.create({
        userId: deletedUser._id,
        postId: externalPost._id,
        postPublicId: externalPost.publicId,
        windowKey: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      postShareModel.create({
        userId: follower._id,
        postId: ownedPost._id,
        postPublicId: ownedPost.publicId,
        windowKey: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      postShareModel.create({
        userId: unrelated._id,
        postId: externalPost._id,
        postPublicId: externalPost.publicId,
        windowKey: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    const deletedUserRecap = await weeklyRecapModel.create({
      userId: deletedUser._id,
      year: 2026,
      weekNumber: 28,
      weekKey: '2026-07-06',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      timezone: RECAP_TIMEZONE,
      stats: {
        postsCount: 1,
        heartsGave: 1,
        heartsReceived: 1,
        topGivers: [follower._id],
        topReceivers: [following._id],
      },
    });

    const retainedRecap = await weeklyRecapModel.create({
      userId: following._id,
      year: 2026,
      weekNumber: 28,
      weekKey: '2026-07-06',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      timezone: RECAP_TIMEZONE,
      stats: {
        postsCount: 1,
        heartsGave: 1,
        heartsReceived: 1,
        topGivers: [deletedUser._id, follower._id],
        topReceivers: [deletedUser._id],
      },
    });

    await Promise.all([
      notificationModel.create({
        recipientId: deletedUser._id,
        type: NotificationType.FOLLOW,
        actorIds: [follower._id],
        countedActorIds: [follower._id],
        actorCount: 1,
        otherCount: 0,
        content: 'follow notification',
        dedupeKey: 'account-delete-recipient',
      }),
      notificationModel.create({
        recipientId: following._id,
        type: NotificationType.REACTION,
        actorIds: [deletedUser._id],
        countedActorIds: [deletedUser._id],
        actorCount: 1,
        otherCount: 0,
        content: 'reaction notification',
        targetId: externalPost._id,
        dedupeKey: 'account-delete-actor',
      }),
      notificationModel.create({
        recipientId: follower._id,
        type: NotificationType.REACTION,
        actorIds: [following._id],
        countedActorIds: [following._id],
        actorCount: 1,
        otherCount: 0,
        content: 'owned post notification',
        targetId: ownedPost._id,
        dedupeKey: 'account-delete-post',
      }),
      notificationModel.create({
        recipientId: follower._id,
        type: NotificationType.RECAP,
        actorIds: [],
        countedActorIds: [],
        actorCount: 0,
        otherCount: 0,
        content: 'recap notification',
        targetId: deletedUserRecap._id,
        dedupeKey: 'account-delete-recap',
      }),
      notificationModel.create({
        recipientId: following._id,
        type: NotificationType.RECAP,
        actorIds: [follower._id],
        countedActorIds: [follower._id],
        actorCount: 1,
        otherCount: 0,
        content: 'unrelated notification',
        targetId: retainedRecap._id,
        dedupeKey: 'account-delete-unrelated',
      }),
    ]);

    await Promise.all([
      engagementEventModel.create({
        eventKey: 'account-delete-actor-event',
        type: EngagementEventType.REACTION_CREATED,
        actorId: deletedUser._id,
        postOwnerId: following._id,
        postId: externalPost._id,
        postPublicId: externalPost.publicId,
        occurredAt: NOW,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
      }),
      engagementEventModel.create({
        eventKey: 'account-delete-owned-post-event',
        type: EngagementEventType.REACTION_CREATED,
        actorId: follower._id,
        postOwnerId: deletedUser._id,
        postId: ownedPost._id,
        postPublicId: ownedPost.publicId,
        occurredAt: NOW,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
      }),
      engagementEventModel.create({
        eventKey: 'account-delete-unrelated-event',
        type: EngagementEventType.REACTION_CREATED,
        actorId: unrelated._id,
        postOwnerId: following._id,
        postId: externalPost._id,
        postPublicId: externalPost.publicId,
        occurredAt: NOW,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
      }),
      streakHistoryModel.create({
        userId: deletedUser._id,
        date: '2026-07-15',
        hasPosted: true,
        pointsChanged: 1,
        currentStreakCount: 5,
      }),
      reportCooldownModel.create({
        reporterId: deletedUser._id,
        targetType: ReportTargetType.USER,
        targetId: following._id,
        nextAllowedAt: new Date(Date.now() + 60_000),
        lastReportId: null,
      }),
      reportCooldownModel.create({
        reporterId: follower._id,
        targetType: ReportTargetType.USER,
        targetId: deletedUser._id,
        nextAllowedAt: new Date(Date.now() + 60_000),
        lastReportId: null,
      }),
      reportCooldownModel.create({
        reporterId: follower._id,
        targetType: ReportTargetType.POST,
        targetId: ownedPost._id,
        nextAllowedAt: new Date(Date.now() + 60_000),
        lastReportId: null,
      }),
      reportCooldownModel.create({
        reporterId: unrelated._id,
        targetType: ReportTargetType.USER,
        targetId: following._id,
        nextAllowedAt: new Date(Date.now() + 60_000),
        lastReportId: null,
      }),
    ]);

    const result = await usersService.softDeleteUser(
      deletedUser._id.toString(),
      CURRENT_PASSWORD,
    );

    await Promise.resolve();

    expect(result.success).toBe(true);

    const storedDeletedUser = await userModel
      .findById(deletedUser._id)
      .select(
        '+refreshToken +forgotPasswordOtp +forgotPasswordExpiry ' +
          '+forgotPasswordAttempts +failedLoginAttempts ' +
          '+failedLoginWindowStartedAt +lockedUntil',
      )
      .lean()
      .exec();

    expect(storedDeletedUser).toEqual(
      expect.objectContaining({
        isDeleted: true,
        refreshToken: null,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        avatarId: DEFAULT_AVATAR_ID,
        avatar: DEFAULT_AVATAR_URL,
        bio: '',
        link: '',
      }),
    );
    expect(storedDeletedUser?.deletedAt).toBeInstanceOf(Date);
    expect(storedDeletedUser?.forgotPasswordOtp).toBeUndefined();
    expect(storedDeletedUser?.failedLoginAttempts).toBeUndefined();

    const [
      storedFollower,
      storedFollowing,
      storedUnrelated,
      storedExternalPost,
      storedRetainedRecap,
    ] = await Promise.all([
      userModel.findById(follower._id).lean().exec(),
      userModel.findById(following._id).lean().exec(),
      userModel.findById(unrelated._id).lean().exec(),
      postModel.findById(externalPost._id).lean().exec(),
      weeklyRecapModel.findById(retainedRecap._id).lean().exec(),
    ]);

    expect(storedFollower?.followingCount).toBe(0);
    expect(storedFollowing?.followersCount).toBe(1);
    expect(storedUnrelated?.followingCount).toBe(1);
    expect(storedExternalPost?.likeCount).toBe(1);

    expect(storedRetainedRecap?.stats.topGivers).toEqual([follower._id]);
    expect(storedRetainedRecap?.stats.topReceivers).toEqual([]);

    const counts = await Promise.all([
      relationshipModel.countDocuments({}),
      blockModel.countDocuments({}),
      postModel.countDocuments({}),
      reactionModel.countDocuments({}),
      postShareModel.countDocuments({}),
      notificationModel.countDocuments({}),
      engagementEventModel.countDocuments({}),
      weeklyRecapModel.countDocuments({}),
      streakHistoryModel.countDocuments({}),
      reportCooldownModel.countDocuments({}),
    ]);

    expect(counts).toEqual([
      1, // unrelated relationship
      1, // unrelated block
      1, // external post
      1, // unrelated reaction
      1, // unrelated share
      1, // unrelated notification
      1, // unrelated engagement event
      1, // retained recap
      0,
      1, // unrelated report cooldown
    ]);

    expect(deleteImagesMock).toHaveBeenCalledTimes(1);
    expect(deleteImagesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'betta/posts/account-owned-a',
        'betta/posts/account-owned-b',
        'betta/avatars/account-delete-avatar',
      ]),
    );

    await expect(
      usersService.softDeleteUser(deletedUser._id.toString(), CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rolls back all MongoDB changes when a cleanup step fails', async () => {
    const deletedUser = await createUser('rollback_deleted', {
      followingCount: 1,
      postsCount: 1,
    });
    const target = await createUser('rollback_target', {
      followersCount: 1,
    });

    const relationship = await relationshipModel.create({
      followerId: deletedUser._id,
      followingId: target._id,
    });

    const post = await createPost(deletedUser._id, 'post_account_rollback', 0);

    forceStreakDeleteFailure = true;

    await expect(
      usersService.softDeleteUser(deletedUser._id.toString(), CURRENT_PASSWORD),
    ).rejects.toThrow('Forced account deletion transaction failure');

    forceStreakDeleteFailure = false;

    const [storedUser, storedRelationship, storedPost, storedTarget] =
      await Promise.all([
        userModel
          .findById(deletedUser._id)
          .select('+refreshToken')
          .lean()
          .exec(),
        relationshipModel.findById(relationship._id).lean().exec(),
        postModel.findById(post._id).lean().exec(),
        userModel.findById(target._id).lean().exec(),
      ]);

    expect(storedUser).toEqual(
      expect.objectContaining({
        isDeleted: false,
        refreshToken: 'sha256-bcrypt-v1:stored-refresh-token-hash',
        followingCount: 1,
        postsCount: 1,
      }),
    );
    expect(storedRelationship).not.toBeNull();
    expect(storedPost).not.toBeNull();
    expect(storedTarget?.followersCount).toBe(1);
    expect(deleteImagesMock).not.toHaveBeenCalled();
  });

  it('allows only one concurrent account deletion to succeed', async () => {
    const user = await createUser('concurrent');

    const outcomes = await Promise.allSettled([
      usersService.softDeleteUser(user._id.toString(), CURRENT_PASSWORD),
      usersService.softDeleteUser(user._id.toString(), CURRENT_PASSWORD),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);

    const storedUser = await userModel
      .findById(user._id)
      .select('+refreshToken')
      .lean()
      .exec();

    expect(storedUser).toEqual(
      expect.objectContaining({
        isDeleted: true,
        refreshToken: null,
      }),
    );
  });
});
