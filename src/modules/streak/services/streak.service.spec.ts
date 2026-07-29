import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import { StreakHistory } from '../schemas/streak.schema';
import { StreakService } from './streak.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  sort: Mock<(sort: unknown) => QueryMock<T>>;
  limit: Mock<(amount: number) => QueryMock<T>>;
  session: Mock<(session: ClientSession) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type UserModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  findOneAndUpdate: ModelMethod;
  updateOne: ModelMethod;
};

type HistoryModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  updateOne: ModelMethod;
  create: ModelMethod;
};

const USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.session = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error ? Promise.reject(error) : Promise.resolve(value),
  );

  return query;
};

const createSession = () => ({
  withTransaction: jest.fn((operation: () => Promise<unknown>) => operation()),
  endSession: jest.fn(() => Promise.resolve()),
});

const createContext = () => {
  const userModel: UserModelMock = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };

  const historyModel: HistoryModelMock = {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    create: jest.fn(),
  };

  const sessions: ReturnType<typeof createSession>[] = [];
  const connection = {
    startSession: jest.fn(() => {
      const session = createSession();
      sessions.push(session);
      return Promise.resolve(session);
    }),
  };

  const service = new StreakService(
    connection as unknown as Connection,
    userModel as unknown as Model<User>,
    historyModel as unknown as Model<StreakHistory>,
  );

  return {
    service,
    userModel,
    historyModel,
    connection,
    sessions,
  };
};

describe('StreakService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('awards exactly one point for the first post in a local day', async () => {
    const { service, userModel, historyModel, sessions } = createContext();

    historyModel.updateOne
      .mockReturnValueOnce(createQuery({ upsertedCount: 1 }))
      .mockReturnValueOnce(createQuery({ modifiedCount: 1 }));
    userModel.findOneAndUpdate.mockReturnValue(
      createQuery({
        _id: USER_ID,
        streakCount: 6,
      }),
    );

    await expect(
      service.recordPostCreated(USER_ID, new Date('2026-07-27T18:30:00.000Z')),
    ).resolves.toEqual({
      awarded: true,
      date: '2026-07-28',
      streakCount: 6,
    });

    expect(historyModel.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        userId: USER_ID,
        date: '2026-07-28',
      },
      {
        $setOnInsert: {
          userId: USER_ID,
          date: '2026-07-28',
          hasPosted: true,
          pointsChanged: 1,
          currentStreakCount: 0,
        },
      },
      {
        upsert: true,
        session: sessions[0],
      },
    );
    expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: USER_ID,
        isDeleted: false,
        status: 'active',
      },
      {
        $inc: {
          streakCount: 1,
        },
      },
      expect.objectContaining({
        session: sessions[0],
      }),
    );
    expect(sessions[0].endSession).toHaveBeenCalledTimes(1);
  });

  it('does not award another point when the day history already exists', async () => {
    const { service, userModel, historyModel } = createContext();

    historyModel.updateOne.mockReturnValue(createQuery({ upsertedCount: 0 }));

    await expect(
      service.recordPostCreated(USER_ID, new Date('2026-07-28T03:00:00.000Z')),
    ).resolves.toEqual({
      awarded: false,
      date: '2026-07-28',
    });

    expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(historyModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it('decays 20 percent, records history and never produces a negative count', async () => {
    const { service, userModel, historyModel, sessions } = createContext();

    userModel.find
      .mockReturnValueOnce(
        createQuery([
          {
            _id: USER_ID,
            streakCount: 10,
          },
        ]),
      )
      .mockReturnValueOnce(createQuery([]));
    historyModel.findOne.mockReturnValue(createQuery(null));
    userModel.findOne.mockReturnValue(
      createQuery({
        _id: USER_ID,
        streakCount: 10,
      }),
    );
    historyModel.create.mockImplementation(() => Promise.resolve([]));
    userModel.updateOne.mockReturnValue(createQuery({ modifiedCount: 1 }));

    await expect(
      service.decayUsersWithoutPostForDate('2026-07-27', 100),
    ).resolves.toEqual({
      date: '2026-07-27',
      processed: 1,
      decayed: 1,
      skipped: 0,
      failed: 0,
    });

    expect(historyModel.create).toHaveBeenCalledWith(
      [
        {
          userId: USER_ID,
          date: '2026-07-27',
          hasPosted: false,
          pointsChanged: -2,
          currentStreakCount: 8,
        },
      ],
      {
        session: sessions[0],
      },
    );
    expect(userModel.updateOne).toHaveBeenCalledWith(
      {
        _id: USER_ID,
        streakCount: 10,
      },
      {
        $set: {
          streakCount: 8,
        },
      },
      {
        session: sessions[0],
      },
    );
  });

  it('skips decay when a history row already exists for the day', async () => {
    const { service, userModel, historyModel } = createContext();

    userModel.find
      .mockReturnValueOnce(
        createQuery([
          {
            _id: USER_ID,
            streakCount: 1,
          },
        ]),
      )
      .mockReturnValueOnce(createQuery([]));
    historyModel.findOne.mockReturnValue(
      createQuery({ _id: new Types.ObjectId() }),
    );

    await expect(
      service.decayUsersWithoutPostForDate('2026-07-27'),
    ).resolves.toMatchObject({
      processed: 1,
      decayed: 0,
      skipped: 1,
      failed: 0,
    });

    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(historyModel.create).not.toHaveBeenCalled();
  });

  it('returns a bounded public streak history summary', async () => {
    const { service, userModel, historyModel } = createContext();

    userModel.findOne.mockReturnValue(
      createQuery({
        streakCount: 7,
      }),
    );
    historyModel.find.mockReturnValue(
      createQuery([
        {
          date: '2026-07-28',
          hasPosted: true,
          pointsChanged: 1,
          currentStreakCount: 7,
        },
        {
          date: '2026-07-27',
          hasPosted: false,
          pointsChanged: -2,
          currentStreakCount: 6,
        },
      ]),
    );

    await expect(
      service.getMyStreakHistory(USER_ID.toString(), 500),
    ).resolves.toEqual({
      success: true,
      data: {
        currentStreakCount: 7,
        totalDaysInWindow: 2,
        postedDaysInWindow: 1,
        missedDaysInWindow: 1,
        history: [
          {
            date: '2026-07-28',
            hasPosted: true,
            pointsChanged: 1,
            currentStreakCount: 7,
          },
          {
            date: '2026-07-27',
            hasPosted: false,
            pointsChanged: -2,
            currentStreakCount: 6,
          },
        ],
      },
      meta: {
        limit: 90,
        count: 2,
      },
    });
  });

  it('rejects malformed authenticated user IDs before querying', async () => {
    const { service, userModel } = createContext();

    await expect(
      service.getMyStreakHistory('invalid-user', 30),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(userModel.findOne).not.toHaveBeenCalled();
  });
});
