import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Reaction } from '../../reactions/schemas/reaction.schema';
import { RecapService } from '../../recap/services/recap.service';
import { StreakService } from '../../streak/services/streak.service';
import {
  type UploadedImage,
  UploadsService,
} from '../../uploads/services/uploads.service';
import { User } from '../../users/schemas/user.schema';
import { PostShare } from '../schemas/post-share.schema';
import { Post } from '../schemas/post.schema';
import { PostsService } from './posts.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  sort: Mock<(sort: unknown) => QueryMock<T>>;
  skip: Mock<(amount: number) => QueryMock<T>>;
  limit: Mock<(amount: number) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  findOneAndDelete: ModelMethod;
  findOneAndUpdate: ModelMethod;
  create: ModelMethod;
  deleteOne: ModelMethod;
  updateOne: ModelMethod;
};

type UploadFileMock = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type RecordPostCreatedEventInput = {
  actorId: Types.ObjectId;
  postId: Types.ObjectId;
  postPublicId: string;
  occurredAt?: Date;
};

const CURRENT_USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const TARGET_USER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');

const POST_ID = new Types.ObjectId('6a4d0e24782427808adea59c');

const SECOND_POST_ID = new Types.ObjectId('6a4d0e24782427808adea59d');

const POST_PUBLIC_ID = 'post_23456789ABCD';
const SECOND_POST_PUBLIC_ID = 'post_EFGHJKLMNPQR';
const IDEMPOTENCY_KEY = 'post-create-key-123456';

const CREATED_AT = new Date('2026-07-14T03:00:00.000Z');
const UPDATED_AT = new Date('2026-07-14T03:01:00.000Z');
const EXPIRE_AT = new Date('2026-07-15T03:00:00.000Z');

const UPLOADED_IMAGES: UploadedImage[] = [
  {
    url: 'https://example.com/post-image.webp',
    publicId: 'betta/posts/post-image',
    width: 1024,
    height: 1024,
    format: 'webp',
    bytes: 12345,
  },
];

const FILES: UploadFileMock[] = [
  {
    buffer: Buffer.from('image'),
    mimetype: 'image/webp',
    size: 1024,
    originalname: 'post.webp',
  },
];

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.skip = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error === undefined ? Promise.resolve(value) : Promise.reject(error),
  );

  return query;
};

const createModelMock = (): ModelMock => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
  findOneAndUpdate: jest.fn(),
  create: jest.fn(),
  deleteOne: jest.fn(),
  updateOne: jest.fn(),
});

const createActiveUser = (
  id: Types.ObjectId = CURRENT_USER_ID,
  overrides: Record<string, unknown> = {},
) => ({
  _id: id,
  publicId:
    id.toString() === CURRENT_USER_ID.toString()
      ? 'usr_WG3FwmJfh6'
      : 'usr_tXdqiPs9aK',
  username:
    id.toString() === CURRENT_USER_ID.toString()
      ? 'current_user'
      : 'target_user',
  fullname:
    id.toString() === CURRENT_USER_ID.toString()
      ? 'Current User'
      : 'Target User',
  avatar: 'https://example.com/avatar.jpg',
  streakCount: 4,
  isDeleted: false,
  status: 'active',
  ...overrides,
});

const createPostDocument = (overrides: Record<string, unknown> = {}): Post => {
  const source = {
    _id: POST_ID,
    publicId: POST_PUBLIC_ID,
    authorId: CURRENT_USER_ID,
    content: 'Nội dung bài viết',
    images: UPLOADED_IMAGES.map(({ url, publicId }) => ({
      url,
      publicId,
    })),
    likeCount: 2,
    shareCount: 3,
    expireAt: EXPIRE_AT,
    isDeletedByAdmin: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };

  return {
    ...source,
    get: jest.fn((field: string) => {
      if (field === 'createdAt') return source.createdAt;
      if (field === 'updatedAt') return source.updatedAt;
      return undefined;
    }),
  } as unknown as Post;
};

const createPostListItem = (overrides: Record<string, unknown> = {}) => ({
  _id: POST_ID,
  publicId: POST_PUBLIC_ID,
  authorId: CURRENT_USER_ID,
  content: 'Nội dung bài viết',
  images: UPLOADED_IMAGES.map(({ url, publicId }) => ({
    url,
    publicId,
  })),
  likeCount: 2,
  shareCount: 3,
  expireAt: EXPIRE_AT,
  createdAt: CREATED_AT,
  ...overrides,
});

const createContext = () => {
  const models = {
    post: createModelMock(),
    user: createModelMock(),
    relationship: createModelMock(),
    block: createModelMock(),
    reaction: createModelMock(),
    postShare: createModelMock(),
  };

  const uploadsService = {
    uploadPostImages: jest.fn<
      (files: UploadFileMock[]) => Promise<UploadedImage[]>
    >(() => Promise.resolve([])),
    deleteImages: jest.fn<(publicIds: string[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const streakService = {
    recordPostCreated: jest.fn<
      (userId: Types.ObjectId, occurredAt: Date) => Promise<unknown>
    >(() => Promise.resolve({ awarded: true })),
  };

  const recapService = {
    recordPostCreatedEvent: jest.fn<
      (input: RecordPostCreatedEventInput) => Promise<void>
    >(() => Promise.resolve()),
  };

  models.user.updateOne.mockImplementation(() =>
    createQuery({ matchedCount: 1, modifiedCount: 1 }),
  );

  models.post.deleteOne.mockImplementation(() =>
    Promise.resolve({ deletedCount: 1 }),
  );

  const service = new PostsService(
    models.post as unknown as Model<Post>,
    models.user as unknown as Model<User>,
    uploadsService as unknown as UploadsService,
    models.relationship as unknown as Model<Relationship>,
    models.block as unknown as Model<Block>,
    models.reaction as unknown as Model<Reaction>,
    models.postShare as unknown as Model<PostShare>,
    streakService as unknown as StreakService,
    recapService as unknown as RecapService,
  );

  return {
    service,
    models,
    uploadsService,
    streakService,
    recapService,
  };
};

describe('PostsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createPost', () => {
    it('rejects an invalid author id before querying MongoDB', async () => {
      const { service, models, uploadsService } = createContext();

      await expect(
        service.createPost('invalid-user-id', {
          content: 'Nội dung',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
      expect(uploadsService.uploadPostImages).not.toHaveBeenCalled();
    });

    it('rejects a post without text and images', async () => {
      const { service, models } = createContext();

      await expect(
        service.createPost(CURRENT_USER_ID.toString(), { content: '   ' }, []),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('rejects an invalid idempotency key', async () => {
      const { service, models } = createContext();

      await expect(
        service.createPost(
          CURRENT_USER_ID.toString(),
          { content: 'Nội dung' },
          [],
          'invalid key',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('rejects an inactive or deleted author', async () => {
      const { service, models, uploadsService } = createContext();

      models.user.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.createPost(CURRENT_USER_ID.toString(), {
          content: 'Nội dung',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.user.findOne).toHaveBeenCalledWith({
        _id: CURRENT_USER_ID,
        isDeleted: false,
        status: 'active',
      });

      expect(uploadsService.uploadPostImages).not.toHaveBeenCalled();
    });

    it('returns the existing post for a repeated idempotency key', async () => {
      const { service, models, uploadsService } = createContext();
      const existingPost = createPostDocument();

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      models.post.findOne.mockReturnValue(createQuery(existingPost));

      const result = await service.createPost(
        CURRENT_USER_ID.toString(),
        { content: 'Nội dung' },
        [],
        IDEMPOTENCY_KEY,
      );

      expect(models.post.findOne).toHaveBeenCalledWith({
        authorId: CURRENT_USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(uploadsService.uploadPostImages).not.toHaveBeenCalled();
      expect(models.post.create).not.toHaveBeenCalled();

      expect(result.data).toEqual({
        id: POST_PUBLIC_ID,
        publicId: POST_PUBLIC_ID,
        content: 'Nội dung bài viết',
        images: [
          {
            url: 'https://example.com/post-image.webp',
            publicId: 'betta/posts/post-image',
          },
        ],
        likeCount: 2,
        shareCount: 3,
        expireAt: EXPIRE_AT,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });

      expect(result.data).not.toHaveProperty('_id');
      expect(result.data).not.toHaveProperty('authorId');
      expect(result.data).not.toHaveProperty('isDeletedByAdmin');
    });

    it('creates a post and records counters, streak and recap', async () => {
      const { service, models, uploadsService, streakService, recapService } =
        createContext();

      const createdPost = createPostDocument({
        content: 'Nội dung đã trim',
      });

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      uploadsService.uploadPostImages.mockImplementation(() =>
        Promise.resolve(UPLOADED_IMAGES),
      );

      models.post.create.mockImplementation(() => Promise.resolve(createdPost));

      const result = await service.createPost(
        CURRENT_USER_ID.toString(),
        { content: '  Nội dung đã trim  ' },
        FILES,
      );

      expect(uploadsService.uploadPostImages).toHaveBeenCalledWith(FILES);

      expect(models.post.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authorId: CURRENT_USER_ID,
          content: 'Nội dung đã trim',
          idempotencyKey: null,
          images: [
            {
              url: 'https://example.com/post-image.webp',
              publicId: 'betta/posts/post-image',
            },
          ],
          publicId: expect.stringMatching(/^post_/),
        }),
      );

      expect(models.user.updateOne).toHaveBeenCalledWith(
        { _id: CURRENT_USER_ID },
        {
          $inc: { postsCount: 1 },
          $set: { lastActive: CREATED_AT },
        },
      );

      expect(streakService.recordPostCreated).toHaveBeenCalledWith(
        CURRENT_USER_ID,
        CREATED_AT,
      );

      expect(recapService.recordPostCreatedEvent).toHaveBeenCalledWith({
        actorId: CURRENT_USER_ID,
        postId: POST_ID,
        postPublicId: POST_PUBLIC_ID,
        occurredAt: CREATED_AT,
      });

      expect(result.success).toBe(true);
      expect(result.data.id).toBe(POST_PUBLIC_ID);
      expect(result.data).not.toHaveProperty('_id');
      expect(result.data).not.toHaveProperty('authorId');
    });

    it('deletes uploaded images when post creation fails', async () => {
      const { service, models, uploadsService } = createContext();
      const writeError = new Error('MongoDB write failed');

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      uploadsService.uploadPostImages.mockImplementation(() =>
        Promise.resolve(UPLOADED_IMAGES),
      );

      models.post.create.mockImplementation(() => Promise.reject(writeError));

      await expect(
        service.createPost(
          CURRENT_USER_ID.toString(),
          { content: 'Nội dung' },
          FILES,
        ),
      ).rejects.toBe(writeError);

      expect(uploadsService.deleteImages).toHaveBeenCalledWith([
        'betta/posts/post-image',
      ]);

      expect(models.user.updateOne).not.toHaveBeenCalled();
      expect(models.post.deleteOne).not.toHaveBeenCalled();
    });

    it('handles a concurrent duplicate idempotency request safely', async () => {
      const { service, models, uploadsService } = createContext();
      const existingPost = createPostDocument();

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      models.post.findOne
        .mockReturnValueOnce(createQuery(null))
        .mockReturnValueOnce(createQuery(existingPost));

      uploadsService.uploadPostImages.mockImplementation(() =>
        Promise.resolve(UPLOADED_IMAGES),
      );

      const duplicateKeyError = Object.assign(
        new Error('Duplicate idempotency key'),
        {
          code: 11000,
          keyPattern: {
            idempotencyKey: 1,
          },
        },
      );

      models.post.create.mockImplementation(() =>
        Promise.reject(duplicateKeyError),
      );

      const result = await service.createPost(
        CURRENT_USER_ID.toString(),
        { content: 'Nội dung' },
        FILES,
        IDEMPOTENCY_KEY,
      );

      expect(uploadsService.deleteImages).toHaveBeenCalledWith([
        'betta/posts/post-image',
      ]);

      expect(result.success).toBe(true);
      expect(result.data.publicId).toBe(POST_PUBLIC_ID);
      expect(models.user.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('deletePost', () => {
    it('rejects an invalid post publicId', async () => {
      const { service, models } = createContext();

      await expect(
        service.deletePost(CURRENT_USER_ID.toString(), 'invalid-post-id'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.user.findOne).not.toHaveBeenCalled();
      expect(models.post.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('does not reveal whether another user owns the post', async () => {
      const { service, models } = createContext();

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      models.post.findOneAndDelete.mockReturnValue(createQuery(null));

      await expect(
        service.deletePost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.post.findOneAndDelete).toHaveBeenCalledWith({
        publicId: POST_PUBLIC_ID,
        authorId: CURRENT_USER_ID,
      });
    });

    it('deletes the owned post, decrements count and cleans images', async () => {
      const { service, models, uploadsService } = createContext();
      const deletedPost = createPostDocument();

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      models.post.findOneAndDelete.mockReturnValue(createQuery(deletedPost));

      const result = await service.deletePost(
        CURRENT_USER_ID.toString(),
        POST_PUBLIC_ID,
      );

      expect(models.user.updateOne).toHaveBeenCalledWith(
        {
          _id: CURRENT_USER_ID,
          postsCount: { $gt: 0 },
        },
        {
          $inc: { postsCount: -1 },
        },
      );

      expect(uploadsService.deleteImages).toHaveBeenCalledWith([
        'betta/posts/post-image',
      ]);

      expect(result).toEqual({
        success: true,
        message: 'Xóa bài viết thành công',
      });
    });
  });

  describe('getFeed', () => {
    it('rejects an invalid current user id', async () => {
      const { service, models } = createContext();

      await expect(
        service.getFeed('invalid-user', {
          page: 1,
          limit: 10,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('returns active visible posts using the public contract', async () => {
      const { service, models } = createContext();

      const firstPost = createPostListItem();
      const secondPost = createPostListItem({
        _id: SECOND_POST_ID,
        publicId: SECOND_POST_PUBLIC_ID,
      });

      models.user.findOne.mockReturnValue(createQuery(createActiveUser()));

      models.relationship.find.mockReturnValue(
        createQuery([
          {
            followerId: CURRENT_USER_ID,
            followingId: TARGET_USER_ID,
          },
        ]),
      );

      models.block.find.mockReturnValue(createQuery([]));

      models.user.find.mockReturnValue(
        createQuery([createActiveUser(), createActiveUser(TARGET_USER_ID)]),
      );

      models.post.find.mockReturnValue(createQuery([firstPost, secondPost]));

      models.reaction.find.mockReturnValue(createQuery([{ postId: POST_ID }]));

      const result = await service.getFeed(CURRENT_USER_ID.toString(), {
        page: 1,
        limit: 1,
      });

      expect(models.post.find).toHaveBeenCalledWith({
        authorId: { $in: [CURRENT_USER_ID, TARGET_USER_ID] },
        expireAt: { $gt: expect.any(Date) },
        isDeletedByAdmin: false,
      });

      expect(result.pagination).toEqual({
        page: 1,
        limit: 1,
        hasMore: true,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: POST_PUBLIC_ID,
          publicId: POST_PUBLIC_ID,
          isReacted: true,
          author: {
            id: 'usr_WG3FwmJfh6',
            publicId: 'usr_WG3FwmJfh6',
            username: 'current_user',
            fullname: 'Current User',
            avatar: 'https://example.com/avatar.jpg',
            streakCount: 4,
          },
        }),
      );

      expect(result.data[0]).not.toHaveProperty('_id');
      expect(result.data[0]).not.toHaveProperty('authorId');
      expect(result.data[0].author).not.toHaveProperty('_id');
    });
  });

  describe('getProfilePosts', () => {
    it('requires following another user before showing posts', async () => {
      const { service, models } = createContext();

      models.user.findOne
        .mockReturnValueOnce(createQuery(createActiveUser()))
        .mockReturnValueOnce(createQuery(createActiveUser(TARGET_USER_ID)));

      models.block.findOne.mockReturnValue(createQuery(null));
      models.relationship.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.getProfilePosts(CURRENT_USER_ID.toString(), 'target_user', {
          page: 1,
          limit: 10,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(models.post.find).not.toHaveBeenCalled();
    });

    it('allows the owner without checking follow relationship', async () => {
      const { service, models } = createContext();
      const owner = createActiveUser();

      models.user.findOne
        .mockReturnValueOnce(createQuery(owner))
        .mockReturnValueOnce(createQuery(owner));

      models.block.findOne.mockReturnValue(createQuery(null));
      models.post.find.mockReturnValue(createQuery([]));

      const result = await service.getProfilePosts(
        CURRENT_USER_ID.toString(),
        'current_user',
        { page: 1, limit: 10 },
      );

      expect(models.relationship.findOne).not.toHaveBeenCalled();
      expect(models.reaction.find).not.toHaveBeenCalled();

      expect(result).toEqual({
        success: true,
        data: [],
        pagination: {
          page: 1,
          limit: 10,
          hasMore: false,
        },
      });
    });
  });

  describe('getPostDetail', () => {
    it('hides a post when the users have blocked each other', async () => {
      const { service, models } = createContext();
      const post = createPostDocument({
        authorId: TARGET_USER_ID,
      });

      models.user.findOne
        .mockReturnValueOnce(createQuery(createActiveUser()))
        .mockReturnValueOnce(createQuery(createActiveUser(TARGET_USER_ID)));

      models.post.findOne.mockReturnValue(createQuery(post));
      models.block.findOne.mockReturnValue(
        createQuery({ _id: new Types.ObjectId() }),
      );

      await expect(
        service.getPostDetail(CURRENT_USER_ID.toString(), POST_PUBLIC_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.relationship.findOne).not.toHaveBeenCalled();
      expect(models.reaction.find).not.toHaveBeenCalled();
    });

    it('returns detail to a follower without exposing internal ids', async () => {
      const { service, models } = createContext();
      const post = createPostDocument({
        authorId: TARGET_USER_ID,
      });

      models.user.findOne
        .mockReturnValueOnce(createQuery(createActiveUser()))
        .mockReturnValueOnce(createQuery(createActiveUser(TARGET_USER_ID)));

      models.post.findOne.mockReturnValue(createQuery(post));
      models.block.findOne.mockReturnValue(createQuery(null));

      models.relationship.findOne.mockReturnValue(
        createQuery({ _id: new Types.ObjectId() }),
      );

      models.reaction.find.mockReturnValue(createQuery([{ postId: POST_ID }]));

      const result = await service.getPostDetail(
        CURRENT_USER_ID.toString(),
        POST_PUBLIC_ID,
      );

      expect(result.data).toEqual(
        expect.objectContaining({
          id: POST_PUBLIC_ID,
          publicId: POST_PUBLIC_ID,
          isReacted: true,
          author: {
            id: 'usr_tXdqiPs9aK',
            publicId: 'usr_tXdqiPs9aK',
            username: 'target_user',
            fullname: 'Target User',
            avatar: 'https://example.com/avatar.jpg',
            streakCount: 4,
          },
        }),
      );

      expect(result.data).not.toHaveProperty('_id');
      expect(result.data).not.toHaveProperty('authorId');
      expect(result.data).not.toHaveProperty('isDeletedByAdmin');
      expect(result.data.author).not.toHaveProperty('_id');
    });
  });

  describe('recordPostShare', () => {
    it('does not increment twice in the same share window', async () => {
      const { service, models } = createContext();
      const post = createPostDocument();

      models.user.findOne
        .mockReturnValueOnce(createQuery(createActiveUser()))
        .mockReturnValueOnce(createQuery(createActiveUser()));

      models.post.findOne
        .mockReturnValueOnce(createQuery(post))
        .mockReturnValueOnce(createQuery({ shareCount: 7 }));

      models.block.findOne.mockReturnValue(createQuery(null));

      models.postShare.updateOne.mockReturnValue(
        createQuery({ upsertedCount: 0 }),
      );

      const result = await service.recordPostShare(
        CURRENT_USER_ID.toString(),
        POST_PUBLIC_ID,
      );

      expect(models.post.findOneAndUpdate).not.toHaveBeenCalled();

      expect(result.data).toEqual({
        counted: false,
        shareCount: 7,
      });
    });

    it('increments share count after claiming a new share window', async () => {
      const { service, models } = createContext();
      const post = createPostDocument();

      models.user.findOne
        .mockReturnValueOnce(createQuery(createActiveUser()))
        .mockReturnValueOnce(createQuery(createActiveUser()));

      models.post.findOne.mockReturnValue(createQuery(post));
      models.block.findOne.mockReturnValue(createQuery(null));

      models.postShare.updateOne.mockReturnValue(
        createQuery({ upsertedCount: 1 }),
      );

      models.post.findOneAndUpdate.mockReturnValue(
        createQuery({ shareCount: 8 }),
      );

      const result = await service.recordPostShare(
        CURRENT_USER_ID.toString(),
        POST_PUBLIC_ID,
      );

      expect(models.post.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: POST_ID,
          expireAt: { $gt: expect.any(Date) },
          isDeletedByAdmin: false,
        },
        {
          $inc: { shareCount: 1 },
        },
        {
          returnDocument: 'after',
        },
      );

      expect(result.data).toEqual({
        counted: true,
        shareCount: 8,
      });
    });
  });
});
