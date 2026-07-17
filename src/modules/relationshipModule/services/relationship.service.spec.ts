import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { User } from '../../users/schemas/user.schema';
import { Block } from '../schemas/block.schema';
import { Relationship } from '../schemas/relationship.schema';
import { RelationshipService } from './relationship.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type LeanPromiseQuery<T> = {
  select: Mock<(fields: string) => LeanPromiseQuery<T>>;
  lean: Mock<() => Promise<T>>;
};

type SessionPromiseQuery<T> = {
  session: Mock<(session: ClientSession) => Promise<T>>;
};

type ModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  findOneAndDelete: ModelMethod;
  exists: ModelMethod;
  create: ModelMethod;
  updateOne: ModelMethod;
  aggregate: ModelMethod;
};

const CURRENT_USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const TARGET_USER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');

const BLOCKED_USER_ID = new Types.ObjectId('6a4d0b24782427808adea4d5');

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));

  return query;
};

const createLeanPromiseQuery = <T>(value: T): LeanPromiseQuery<T> => {
  const query = {} as LeanPromiseQuery<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => Promise.resolve(value));

  return query;
};

const createSessionPromiseQuery = <T>(value: T): SessionPromiseQuery<T> => ({
  session: jest.fn(() => Promise.resolve(value)),
});

const createModelMock = (): ModelMock => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
  exists: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  aggregate: jest.fn(),
});

const createUserListItem = (overrides: Record<string, unknown> = {}) => ({
  _id: TARGET_USER_ID,
  publicId: 'usr_tXdqiPs9aK',
  username: 'target_user',
  fullname: 'Target User',
  avatar: 'https://example.com/avatar.jpg',
  bio: 'Public bio',
  streakCount: 3,
  ...overrides,
});

type FollowNotificationInput = {
  followerId: Types.ObjectId;
  targetUserId: Types.ObjectId;
};

const createContext = () => {
  const relationshipModel = createModelMock();
  const userModel = createModelMock();
  const blockModel = createModelMock();

  const session = {
    withTransaction: jest.fn((operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: jest.fn(() => Promise.resolve()),
  };

  const connection = {
    startSession: jest.fn(() => Promise.resolve(session)),
  };

  const notificationsService = {
    createFollowNotification: jest.fn<
      (input: FollowNotificationInput) => Promise<void>
    >(() => Promise.resolve()),
  };

  /*
   * Mặc định mọi update user đều thành công.
   * Bao gồm pair-lock và các counter update.
   */
  userModel.updateOne.mockImplementation(() =>
    Promise.resolve({ matchedCount: 1 }),
  );

  const service = new RelationshipService(
    connection as unknown as Connection,
    relationshipModel as unknown as Model<Relationship>,
    userModel as unknown as Model<User>,
    blockModel as unknown as Model<Block>,
    notificationsService as unknown as NotificationsService,
  );

  return {
    service,
    relationshipModel,
    userModel,
    blockModel,
    session,
    connection,
    notificationsService,
  };
};

describe('RelationshipService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('followUser', () => {
    it('rejects an invalid current user id before querying MongoDB', async () => {
      const { service, userModel, connection } = createContext();

      await expect(
        service.followUser('invalid-current-user', 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('rejects an invalid target identifier', async () => {
      const { service, userModel } = createContext();

      await expect(
        service.followUser(CURRENT_USER_ID.toString(), 'invalid-target'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
    });

    it('resolves a publicId using only active users', async () => {
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.followUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(userModel.findOne).toHaveBeenCalledWith({
        publicId: 'usr_tXdqiPs9aK',
        isDeleted: false,
        status: 'active',
      });
    });

    it('rejects following the current user', async () => {
      const { service, userModel, connection } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: CURRENT_USER_ID }));

      await expect(
        service.followUser(
          CURRENT_USER_ID.toString(),
          CURRENT_USER_ID.toString(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('hides the target when either user has blocked the other', async () => {
      const { service, userModel, blockModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(true));

      await expect(
        service.followUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(relationshipModel.create).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('rejects an existing relationship', async () => {
      const { service, userModel, blockModel, relationshipModel } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      relationshipModel.exists.mockReturnValue(createSessionPromiseQuery(true));

      await expect(
        service.followUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(relationshipModel.create).not.toHaveBeenCalled();
    });

    it('creates the relationship and updates both counters transactionally', async () => {
      const {
        service,
        userModel,
        blockModel,
        relationshipModel,
        session,
        notificationsService,
      } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      relationshipModel.exists.mockReturnValue(
        createSessionPromiseQuery(false),
      );

      relationshipModel.create.mockReturnValue(
        Promise.resolve([
          {
            followerId: CURRENT_USER_ID,
            followingId: TARGET_USER_ID,
          },
        ]),
      );

      const result = await service.followUser(
        CURRENT_USER_ID.toString(),
        'usr_tXdqiPs9aK',
      );

      expect(result).toStrictEqual({
        success: true,
        message: 'Đã theo dõi thành công',
      });

      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalledTimes(1);

      expect(relationshipModel.create).toHaveBeenCalledWith(
        [
          {
            followerId: CURRENT_USER_ID,
            followingId: TARGET_USER_ID,
          },
        ],
        { session },
      );

      /*
       * Hai update đầu là pair lock.
       * Hai update sau là followingCount/followersCount.
       */
      expect(userModel.updateOne).toHaveBeenCalledTimes(4);

      expect(userModel.updateOne).toHaveBeenNthCalledWith(
        3,
        {
          _id: CURRENT_USER_ID,
          isDeleted: false,
          status: 'active',
        },
        { $inc: { followingCount: 1 } },
        { session },
      );

      expect(userModel.updateOne).toHaveBeenNthCalledWith(
        4,
        {
          _id: TARGET_USER_ID,
          isDeleted: false,
          status: 'active',
        },
        { $inc: { followersCount: 1 } },
        { session },
      );

      expect(
        notificationsService.createFollowNotification,
      ).toHaveBeenCalledWith({
        followerId: CURRENT_USER_ID,
        targetUserId: TARGET_USER_ID,
      });
    });

    it('maps MongoDB duplicate key errors to ConflictException', async () => {
      const { service, userModel, blockModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      relationshipModel.exists.mockReturnValue(
        createSessionPromiseQuery(false),
      );

      const duplicateError = Object.assign(
        new Error('duplicate relationship'),
        { code: 11000 },
      );

      relationshipModel.create.mockReturnValue(Promise.reject(duplicateError));

      await expect(
        service.followUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('unfollowUser', () => {
    it('rejects when the target user does not exist', async () => {
      const { service, userModel, connection } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.unfollowUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('rejects when no relationship exists', async () => {
      const { service, userModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists.mockReturnValue(createSessionPromiseQuery(true));

      relationshipModel.findOneAndDelete.mockReturnValue(Promise.resolve(null));

      await expect(
        service.unfollowUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.updateOne).toHaveBeenCalledTimes(2);
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('deletes the relationship and decrements counters without going below zero', async () => {
      const { service, userModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists.mockReturnValue(createSessionPromiseQuery(true));

      relationshipModel.findOneAndDelete.mockReturnValue(
        Promise.resolve({
          followerId: CURRENT_USER_ID,
          followingId: TARGET_USER_ID,
        }),
      );

      const result = await service.unfollowUser(
        CURRENT_USER_ID.toString(),
        'usr_tXdqiPs9aK',
      );

      expect(result).toStrictEqual({
        success: true,
        message: 'Đã bỏ theo dõi thành công',
      });

      expect(relationshipModel.findOneAndDelete).toHaveBeenCalledWith(
        {
          followerId: CURRENT_USER_ID,
          followingId: TARGET_USER_ID,
        },
        { session },
      );

      /*
       * Hai update đầu là pair lock, hai update sau là decrement.
       */
      expect(userModel.updateOne).toHaveBeenCalledTimes(4);

      expect(userModel.updateOne).toHaveBeenNthCalledWith(
        3,
        {
          _id: CURRENT_USER_ID,
          isDeleted: false,
        },
        [
          {
            $set: {
              followingCount: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ['$followingCount', 0] }, 1],
                  },
                ],
              },
            },
          },
        ],
        {
          session,
          updatePipeline: true,
        },
      );

      expect(userModel.updateOne).toHaveBeenNthCalledWith(
        4,
        {
          _id: TARGET_USER_ID,
          isDeleted: false,
        },
        [
          {
            $set: {
              followersCount: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ['$followersCount', 0] }, 1],
                  },
                ],
              },
            },
          },
        ],
        {
          session,
          updatePipeline: true,
        },
      );
    });
  });

  describe('getFollowers', () => {
    it('filters blocked/deleted users and returns public identities', async () => {
      const { service, userModel, relationshipModel, blockModel } =
        createContext();

      const follower = createUserListItem();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      blockModel.find.mockReturnValue(
        createLeanPromiseQuery([
          {
            blockerId: CURRENT_USER_ID,
            blockedId: BLOCKED_USER_ID,
          },
        ]),
      );

      relationshipModel.aggregate
        .mockReturnValueOnce(Promise.resolve([follower]))
        .mockReturnValueOnce(Promise.resolve([{ total: 21 }]));

      relationshipModel.find.mockReturnValue(
        createLeanPromiseQuery([{ followingId: TARGET_USER_ID }]),
      );

      const result = await service.getFollowers(
        'usr_tXdqiPs9aK',
        CURRENT_USER_ID.toString(),
        1,
        20,
      );

      const dataPipeline = relationshipModel.aggregate.mock
        .calls[0]?.[0] as Array<Record<string, unknown>>;

      expect(dataPipeline).toContainEqual({
        $match: {
          'followerUser._id': {
            $nin: [BLOCKED_USER_ID],
          },
        },
      });

      expect(result).toStrictEqual({
        success: true,
        data: [
          {
            id: 'usr_tXdqiPs9aK',
            publicId: 'usr_tXdqiPs9aK',
            username: 'target_user',
            fullname: 'Target User',
            avatar: 'https://example.com/avatar.jpg',
            bio: 'Public bio',
            streakCount: 3,
            isFollowing: true,
          },
        ],
        pagination: {
          total: 21,
          page: 1,
          limit: 20,
          totalPages: 2,
          hasMore: true,
        },
      });
    });

    it('rejects an invalid target identifier', async () => {
      const { service, userModel } = createContext();

      await expect(
        service.getFollowers('invalid-target', CURRENT_USER_ID.toString()),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('getFollowing', () => {
    it('returns an empty page with stable pagination', async () => {
      const { service, userModel, relationshipModel, blockModel } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      blockModel.find.mockReturnValue(createLeanPromiseQuery([]));

      relationshipModel.aggregate
        .mockReturnValueOnce(Promise.resolve([]))
        .mockReturnValueOnce(Promise.resolve([]));

      relationshipModel.find.mockReturnValue(createLeanPromiseQuery([]));

      const result = await service.getFollowing(
        'usr_tXdqiPs9aK',
        CURRENT_USER_ID.toString(),
        1,
        20,
      );

      expect(result).toStrictEqual({
        success: true,
        data: [],
        pagination: {
          total: 0,
          page: 1,
          limit: 20,
          totalPages: 0,
          hasMore: false,
        },
      });
    });
  });
});
