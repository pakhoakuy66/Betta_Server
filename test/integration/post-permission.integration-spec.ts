import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
import {
  Block,
  BlockSchema,
} from '../../src/modules/relationshipModule/schemas/block.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../../src/modules/relationshipModule/schemas/relationship.schema';
import {
  PostShare,
  PostShareSchema,
} from '../../src/modules/posts/schemas/post-share.schema';
import { Post, PostSchema } from '../../src/modules/posts/schemas/post.schema';
import { PostsService } from '../../src/modules/posts/services/posts.service';
import {
  Reaction,
  ReactionSchema,
} from '../../src/modules/reactions/schemas/reaction.schema';
import { RecapService } from '../../src/modules/recap/services/recap.service';
import { StreakService } from '../../src/modules/streak/services/streak.service';
import { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const MONGODB_URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';

const TEST_DATABASE_PREFIX = 'betta_post_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}`;

const POST_IDS = {
  ownerDetail: 'post_23456789ABCD',
  followerDetail: 'post_23456789ABCE',
  blockedDetail: 'post_23456789ABCF',
  expiredDetail: 'post_23456789ABCG',
  hiddenDetail: 'post_23456789ABCH',
  profileLive: 'post_23456789ABCJ',
  profileExpired: 'post_23456789ABCK',
  profileHidden: 'post_23456789ABCM',
  foreignDelete: 'post_23456789ABCN',
  ownerDelete: 'post_23456789ABCP',
} as const;

type UserFixture = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
};

type PostFixtureOptions = {
  content?: string;
  expireAt?: Date;
  isDeletedByAdmin?: boolean;
  images?: Array<{
    url: string;
    publicId: string;
  }>;
};

jest.setTimeout(60_000);

if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
  throw new Error('Tên Post integration database vượt quá giới hạn an toàn');
}

if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
  throw new Error('Tên Post integration database không an toàn');
}

describe('Post permission MongoDB integration', () => {
  let connection: Connection;

  let userModel: Model<User>;
  let postModel: Model<Post>;
  let relationshipModel: Model<Relationship>;
  let blockModel: Model<Block>;
  let reactionModel: Model<Reaction>;
  let postShareModel: Model<PostShare>;

  let postsService: PostsService;
  let userSequence = 0;

  const uploadsService = {
    deleteImages: jest.fn<(publicIds: string[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const createUser = async (
    label: string,
    postsCount = 0,
  ): Promise<UserFixture> => {
    userSequence += 1;

    const document = await userModel.create({
      publicId: `usr_post_it_${label}`,
      username: `post_it_${label}`,
      fullname: `Post Integration ${label}`,
      phone: `09${userSequence.toString().padStart(8, '0')}`,
      email: `post_it_${label}@example.com`,
      password: 'integration-password-hash',
      status: 'active',
      isDeleted: false,
      postsCount,
    });

    return {
      _id: document._id,
      publicId: document.publicId,
      username: document.username,
    };
  };

  const createPost = async (
    authorId: Types.ObjectId,
    publicId: string,
    options: PostFixtureOptions = {},
  ): Promise<Post> =>
    postModel.create({
      publicId,
      authorId,
      content: options.content ?? 'Integration post',
      images: options.images ?? [],
      likeCount: 0,
      shareCount: 0,
      expireAt: options.expireAt ?? new Date(Date.now() + 60 * 60 * 1000),
      isDeletedByAdmin: options.isDeletedByAdmin ?? false,
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

    relationshipModel = connection.model<Relationship>(
      Relationship.name,
      RelationshipSchema,
    );

    blockModel = connection.model<Block>(Block.name, BlockSchema);

    reactionModel = connection.model<Reaction>(Reaction.name, ReactionSchema);

    postShareModel = connection.model<PostShare>(
      PostShare.name,
      PostShareSchema,
    );

    await Promise.all([
      userModel.syncIndexes(),
      postModel.syncIndexes(),
      relationshipModel.syncIndexes(),
      blockModel.syncIndexes(),
      reactionModel.syncIndexes(),
      postShareModel.syncIndexes(),
    ]);

    postsService = new PostsService(
      postModel,
      userModel,
      uploadsService as unknown as UploadsService,
      relationshipModel,
      blockModel,
      reactionModel,
      postShareModel,
      {} as StreakService,
      {} as RecapService,
    );
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    userSequence = 0;

    await Promise.all([
      reactionModel.deleteMany({}),
      postShareModel.deleteMany({}),
      relationshipModel.deleteMany({}),
      blockModel.deleteMany({}),
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

  it('allows the owner to view post detail without following', async () => {
    const owner = await createUser('owner_detail');

    await createPost(owner._id, POST_IDS.ownerDetail);

    const result = await postsService.getPostDetail(
      owner._id.toString(),
      POST_IDS.ownerDetail,
    );

    expect(result.data).toEqual(
      expect.objectContaining({
        id: POST_IDS.ownerDetail,
        publicId: POST_IDS.ownerDetail,
        isReacted: false,
        author: expect.objectContaining({
          id: owner.publicId,
          publicId: owner.publicId,
          username: owner.username,
        }),
      }),
    );

    expect(result.data).not.toHaveProperty('_id');
    expect(result.data).not.toHaveProperty('authorId');
    expect(result.data.author).not.toHaveProperty('_id');
  });

  it('requires following before another user can view post detail', async () => {
    const viewer = await createUser('detail_viewer');
    const author = await createUser('detail_author');

    await createPost(author._id, POST_IDS.followerDetail);

    await expect(
      postsService.getPostDetail(
        viewer._id.toString(),
        POST_IDS.followerDetail,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await relationshipModel.create({
      followerId: viewer._id,
      followingId: author._id,
    });

    const post = await postModel.findOne({
      publicId: POST_IDS.followerDetail,
    });

    if (!post) {
      throw new Error('Không tìm thấy Post fixture');
    }

    await reactionModel.create({
      userId: viewer._id,
      postId: post._id,
      postOwnerId: author._id,
      emojiType: 'heart',
    });

    const result = await postsService.getPostDetail(
      viewer._id.toString(),
      POST_IDS.followerDetail,
    );

    expect(result.data).toEqual(
      expect.objectContaining({
        publicId: POST_IDS.followerDetail,
        isReacted: true,
      }),
    );
  });

  it('hides post detail when either user has blocked the other', async () => {
    const viewer = await createUser('blocked_viewer');
    const author = await createUser('blocked_author');

    await createPost(author._id, POST_IDS.blockedDetail);

    await relationshipModel.create({
      followerId: viewer._id,
      followingId: author._id,
    });

    await blockModel.create({
      blockerId: viewer._id,
      blockedId: author._id,
    });

    await expect(
      postsService.getPostDetail(viewer._id.toString(), POST_IDS.blockedDetail),
    ).rejects.toBeInstanceOf(NotFoundException);

    await blockModel.deleteMany({});

    await blockModel.create({
      blockerId: author._id,
      blockedId: viewer._id,
    });

    await expect(
      postsService.getPostDetail(viewer._id.toString(), POST_IDS.blockedDetail),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides expired and admin-deleted posts', async () => {
    const owner = await createUser('hidden_owner');

    await Promise.all([
      createPost(owner._id, POST_IDS.expiredDetail, {
        expireAt: new Date(Date.now() - 60_000),
      }),
      createPost(owner._id, POST_IDS.hiddenDetail, {
        isDeletedByAdmin: true,
      }),
    ]);

    await expect(
      postsService.getPostDetail(owner._id.toString(), POST_IDS.expiredDetail),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      postsService.getPostDetail(owner._id.toString(), POST_IDS.hiddenDetail),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces follow permission and visibility filters for profile posts', async () => {
    const viewer = await createUser('profile_viewer');
    const author = await createUser('profile_author');

    await Promise.all([
      createPost(author._id, POST_IDS.profileLive),
      createPost(author._id, POST_IDS.profileExpired, {
        expireAt: new Date(Date.now() - 60_000),
      }),
      createPost(author._id, POST_IDS.profileHidden, {
        isDeletedByAdmin: true,
      }),
    ]);

    await expect(
      postsService.getProfilePosts(viewer._id.toString(), author.username, {
        page: 1,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await relationshipModel.create({
      followerId: viewer._id,
      followingId: author._id,
    });

    const result = await postsService.getProfilePosts(
      viewer._id.toString(),
      author.username,
      {
        page: 1,
        limit: 10,
      },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        id: POST_IDS.profileLive,
        publicId: POST_IDS.profileLive,
      }),
    );

    expect(result.data[0]).not.toHaveProperty('_id');
    expect(result.data[0]).not.toHaveProperty('authorId');
  });

  it('does not let another user delete a post or reveal ownership', async () => {
    const owner = await createUser('foreign_delete_owner', 1);

    const attacker = await createUser('foreign_delete_attacker');

    await createPost(owner._id, POST_IDS.foreignDelete);

    await expect(
      postsService.deletePost(attacker._id.toString(), POST_IDS.foreignDelete),
    ).rejects.toBeInstanceOf(NotFoundException);

    const [remainingPost, refreshedOwner] = await Promise.all([
      postModel.findOne({
        publicId: POST_IDS.foreignDelete,
      }),
      userModel.findById(owner._id),
    ]);

    expect(remainingPost).not.toBeNull();
    expect(refreshedOwner?.postsCount).toBe(1);
    expect(uploadsService.deleteImages).not.toHaveBeenCalled();
  });

  it('lets the owner delete the post and decrements post count', async () => {
    const owner = await createUser('owner_delete', 1);

    await createPost(owner._id, POST_IDS.ownerDelete, {
      images: [
        {
          url: 'https://example.com/post.jpg',
          publicId: 'betta/posts/integration-post',
        },
      ],
    });

    await expect(
      postsService.deletePost(owner._id.toString(), POST_IDS.ownerDelete),
    ).resolves.toEqual({
      success: true,
      message: 'Xóa bài viết thành công',
    });

    const [deletedPost, refreshedOwner] = await Promise.all([
      postModel.findOne({
        publicId: POST_IDS.ownerDelete,
      }),
      userModel.findById(owner._id),
    ]);

    expect(deletedPost).toBeNull();
    expect(refreshedOwner?.postsCount).toBe(0);

    expect(uploadsService.deleteImages).toHaveBeenCalledWith([
      'betta/posts/integration-post',
    ]);
  });
});
