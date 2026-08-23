import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import { Block } from '../schemas/block.schema';
import { Relationship } from '../schemas/relationship.schema';
import { BlockService } from './block.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  populate: Mock<(path: string, fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
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
};

const CURRENT_USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const TARGET_USER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');

const SECOND_TARGET_ID = new Types.ObjectId('6a4d0b24782427808adea4d5');

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.populate = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));

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
});

const createContext = () => {
  const blockModel = createModelMock();
  const relationshipModel = createModelMock();
  const userModel = createModelMock();

  const session = {
    withTransaction: jest.fn((operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: jest.fn(() => Promise.resolve()),
  };

  const connection = {
    startSession: jest.fn(() => Promise.resolve(session)),
  };

  /*
   * Mặc định pair lock và counter update đều tìm thấy user.
   */
  userModel.updateOne.mockImplementation(() =>
    Promise.resolve({ matchedCount: 1 }),
  );

  const service = new BlockService(
    connection as unknown as Connection,
    blockModel as unknown as Model<Block>,
    relationshipModel as unknown as Model<Relationship>,
    userModel as unknown as Model<User>,
  );

  return {
    service,
    blockModel,
    relationshipModel,
    userModel,
    session,
    connection,
  };
};

describe('BlockService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('blockUser', () => {
    it('rejects an invalid current user id before querying MongoDB', async () => {
      const { service, userModel, connection } = createContext();

      await expect(
        service.blockUser('invalid-current-user', 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('rejects an invalid target identifier', async () => {
      const { service, userModel } = createContext();

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'invalid-target'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
    });

    it('resolves publicId using only active non-deleted users', async () => {
      const { service, userModel, connection } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          publicId: 'usr_tXdqiPs9aK',
          isDeleted: false,
          status: 'active',
          $or: expect.any(Array),
        }),
      );
      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('rejects blocking the current user', async () => {
      const { service, userModel, connection } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: CURRENT_USER_ID }));

      await expect(
        service.blockUser(
          CURRENT_USER_ID.toString(),
          CURRENT_USER_ID.toString(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('rejects when the current account becomes inactive inside transaction', async () => {
      const { service, userModel, blockModel, session } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists.mockReturnValueOnce(createSessionPromiseQuery(false));

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(blockModel.create).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('rejects when the target account becomes inactive inside transaction', async () => {
      const { service, userModel, blockModel, session } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(false));

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(blockModel.create).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('rejects an existing block relation', async () => {
      const { service, userModel, blockModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(true));

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(blockModel.create).not.toHaveBeenCalled();
    });

    it('creates a block and removes both follow directions transactionally', async () => {
      const { service, userModel, blockModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      blockModel.create.mockReturnValue(
        Promise.resolve([
          {
            blockerId: CURRENT_USER_ID,
            blockedId: TARGET_USER_ID,
          },
        ]),
      );

      relationshipModel.findOneAndDelete
        .mockReturnValueOnce(
          Promise.resolve({
            followerId: CURRENT_USER_ID,
            followingId: TARGET_USER_ID,
          }),
        )
        .mockReturnValueOnce(
          Promise.resolve({
            followerId: TARGET_USER_ID,
            followingId: CURRENT_USER_ID,
          }),
        );

      const result = await service.blockUser(
        CURRENT_USER_ID.toString(),
        'usr_tXdqiPs9aK',
      );

      expect(result).toStrictEqual({
        success: true,
        message: 'Đã chặn người dùng thành công',
      });

      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalledTimes(1);

      expect(blockModel.create).toHaveBeenCalledWith(
        [
          {
            blockerId: CURRENT_USER_ID,
            blockedId: TARGET_USER_ID,
          },
        ],
        { session },
      );

      expect(relationshipModel.findOneAndDelete).toHaveBeenNthCalledWith(
        1,
        {
          followerId: CURRENT_USER_ID,
          followingId: TARGET_USER_ID,
        },
        { session },
      );

      expect(relationshipModel.findOneAndDelete).toHaveBeenNthCalledWith(
        2,
        {
          followerId: TARGET_USER_ID,
          followingId: CURRENT_USER_ID,
        },
        { session },
      );

      /*
       * Hai update đầu là pair lock.
       * Bốn update sau giảm counter cho hai chiều follow.
       */
      expect(userModel.updateOne).toHaveBeenCalledTimes(6);

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

      expect(userModel.updateOne).toHaveBeenNthCalledWith(
        5,
        {
          _id: TARGET_USER_ID,
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
        6,
        {
          _id: CURRENT_USER_ID,
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

    it('does not decrement counters when no follow relationship exists', async () => {
      const { service, userModel, blockModel, relationshipModel } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      blockModel.create.mockReturnValue(
        Promise.resolve([
          {
            blockerId: CURRENT_USER_ID,
            blockedId: TARGET_USER_ID,
          },
        ]),
      );

      relationshipModel.findOneAndDelete
        .mockReturnValueOnce(Promise.resolve(null))
        .mockReturnValueOnce(Promise.resolve(null));

      await service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK');

      // Chỉ có hai pair-lock update.
      expect(userModel.updateOne).toHaveBeenCalledTimes(2);
    });

    it('maps Mongo duplicate key to ConflictException', async () => {
      const { service, userModel, blockModel, relationshipModel, session } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      userModel.exists
        .mockReturnValueOnce(createSessionPromiseQuery(true))
        .mockReturnValueOnce(createSessionPromiseQuery(true));

      blockModel.exists.mockReturnValue(createSessionPromiseQuery(false));

      const duplicateError = Object.assign(new Error('duplicate block'), {
        code: 11000,
      });

      blockModel.create.mockReturnValue(Promise.reject(duplicateError));

      relationshipModel.findOneAndDelete
        .mockReturnValueOnce(Promise.resolve(null))
        .mockReturnValueOnce(Promise.resolve(null));

      await expect(
        service.blockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('unblockUser', () => {
    it('rejects an invalid current user id', async () => {
      const { service, userModel, blockModel } = createContext();

      await expect(
        service.unblockUser('invalid-current-user', 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
      expect(blockModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('rejects when no block relation exists', async () => {
      const { service, userModel, blockModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      blockModel.findOneAndDelete.mockReturnValue(Promise.resolve(null));

      await expect(
        service.unblockUser(CURRENT_USER_ID.toString(), 'usr_tXdqiPs9aK'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deletes only the current user block direction', async () => {
      const { service, userModel, blockModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery({ _id: TARGET_USER_ID }));

      blockModel.findOneAndDelete.mockReturnValue(
        Promise.resolve({
          blockerId: CURRENT_USER_ID,
          blockedId: TARGET_USER_ID,
        }),
      );

      const result = await service.unblockUser(
        CURRENT_USER_ID.toString(),
        'usr_tXdqiPs9aK',
      );

      expect(blockModel.findOneAndDelete).toHaveBeenCalledWith({
        blockerId: CURRENT_USER_ID,
        blockedId: TARGET_USER_ID,
      });

      expect(result).toStrictEqual({
        success: true,
        message: 'Đã bỏ chặn người dùng',
      });
    });
  });

  describe('getBlockedUsers', () => {
    it('rejects an invalid current user id before querying MongoDB', async () => {
      const { service, blockModel } = createContext();

      await expect(
        service.getBlockedUsers('invalid-user'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(blockModel.find).not.toHaveBeenCalled();
    });

    it('filters missing/deleted users and returns only public identity', async () => {
      const { service, blockModel } = createContext();

      const query = createQuery([
        {
          blockedId: {
            _id: TARGET_USER_ID,
            publicId: 'usr_tXdqiPs9aK',
            username: 'target_user',
            fullname: 'Target User',
            avatar: 'https://example.com/avatar.jpg',
            streakCount: 3,
            isDeleted: false,
            status: 'active',
            restriction: null,
          },
        },
        {
          blockedId: {
            _id: SECOND_TARGET_ID,
            publicId: 'usr_deleted01',
            username: 'deleted_user',
            fullname: 'Deleted User',
            isDeleted: true,
          },
        },
        {
          blockedId: null,
        },
      ]);

      blockModel.find.mockReturnValue(query);

      const result = await service.getBlockedUsers(CURRENT_USER_ID.toString());

      expect(blockModel.find).toHaveBeenCalledWith({
        blockerId: CURRENT_USER_ID,
      });

      expect(query.populate).toHaveBeenCalledWith(
        'blockedId',
        'publicId username fullname avatar streakCount isDeleted status +restriction',
      );

      expect(result).toStrictEqual({
        success: true,
        data: [
          {
            id: 'usr_tXdqiPs9aK',
            publicId: 'usr_tXdqiPs9aK',
            username: 'target_user',
            fullname: 'Target User',
            avatar: 'https://example.com/avatar.jpg',
            streakCount: 3,
          },
        ],
      });
    });
  });
});
