import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import {
  EngagementEvent,
  EngagementEventType,
} from '../schemas/engagement-event.schema';
import { WeeklyRecap } from '../schemas/recap.schema';
import { RECAP_TIMEZONE } from '../utils/recap-week.util';
import { RecapService } from './recap.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  sort: Mock<(sort: unknown) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMock = {
  create: ModelMethod;
  aggregate: ModelMethod;
  find: ModelMethod;
  findOne: ModelMethod;
  updateOne: ModelMethod;
  bulkWrite: ModelMethod;
};

const USER_A_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const USER_B_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');
const POST_ID = new Types.ObjectId('6a4d0e24782427808adea59c');
const RECAP_ID = new Types.ObjectId('6a4d0e24782427808adea59d');
const WEEK_START = new Date('2026-07-19T17:00:00.000Z');
const WEEK_END = new Date('2026-07-26T17:00:00.000Z');

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error ? Promise.reject(error) : Promise.resolve(value),
  );

  return query;
};

const createAggregateQuery = <T>(value: T) => ({
  exec: jest.fn(() => Promise.resolve(value)),
});

const createModelMock = (): ModelMock => ({
  create: jest.fn(),
  aggregate: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  bulkWrite: jest.fn(),
});

const createContext = () => {
  const engagementEventModel = createModelMock();
  const weeklyRecapModel = createModelMock();
  const userModel = createModelMock();

  const service = new RecapService(
    engagementEventModel as unknown as Model<EngagementEvent>,
    weeklyRecapModel as unknown as Model<WeeklyRecap>,
    userModel as unknown as Model<User>,
  );

  return {
    service,
    engagementEventModel,
    weeklyRecapModel,
    userModel,
  };
};

describe('RecapService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records one deterministic post-created engagement event', async () => {
    const { service, engagementEventModel } = createContext();
    const occurredAt = new Date('2026-07-22T03:00:00.000Z');

    engagementEventModel.create.mockImplementation(() => Promise.resolve({}));

    await service.recordPostCreatedEvent({
      actorId: USER_A_ID,
      postId: POST_ID,
      postPublicId: 'post_23456789ABCD',
      occurredAt,
    });

    expect(engagementEventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `${EngagementEventType.POST_CREATED}:${POST_ID.toString()}`,
        type: EngagementEventType.POST_CREATED,
        actorId: USER_A_ID,
        postOwnerId: USER_A_ID,
        postId: POST_ID,
        postPublicId: 'post_23456789ABCD',
        occurredAt,
        timezone: RECAP_TIMEZONE,
      }),
    );
  });

  it('treats a duplicate engagement event as idempotent', async () => {
    const { service, engagementEventModel } = createContext();

    engagementEventModel.create.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('Duplicate engagement event'), {
          code: 11000,
        }),
      ),
    );

    await expect(
      service.recordReactionCreatedEvent({
        actorId: USER_B_ID,
        postOwnerId: USER_A_ID,
        postId: POST_ID,
        postPublicId: 'post_23456789ABCD',
        occurredAt: new Date('2026-07-22T03:00:00.000Z'),
      }),
    ).resolves.toBeUndefined();
  });

  it('aggregates weekly stats only for active users and upserts one recap per user', async () => {
    const { service, engagementEventModel, weeklyRecapModel, userModel } =
      createContext();

    engagementEventModel.aggregate
      .mockReturnValueOnce(
        createAggregateQuery([
          {
            _id: USER_A_ID,
            count: 2,
          },
        ]),
      )
      .mockReturnValueOnce(
        createAggregateQuery([
          {
            heartsReceived: [
              {
                _id: USER_A_ID,
                count: 3,
              },
            ],
            heartsGave: [
              {
                _id: USER_B_ID,
                count: 3,
              },
            ],
            topGivers: [
              {
                _id: USER_A_ID,
                users: [USER_B_ID],
              },
            ],
            topReceivers: [
              {
                _id: USER_B_ID,
                users: [USER_A_ID],
              },
            ],
          },
        ]),
      );
    userModel.find.mockReturnValue(
      createQuery([
        {
          _id: USER_A_ID,
        },
        {
          _id: USER_B_ID,
        },
      ]),
    );
    weeklyRecapModel.bulkWrite.mockImplementation(() =>
      Promise.resolve({
        upsertedCount: 2,
        modifiedCount: 0,
        matchedCount: 0,
      }),
    );

    const result = await service.aggregateWeeklyRecap({
      weekStart: WEEK_START,
    });

    expect(result).toEqual({
      success: true,
      data: {
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
        processed: 2,
        upserted: 2,
        modified: 0,
        matched: 0,
      },
    });

    const operations = weeklyRecapModel.bulkWrite.mock.calls[0][0] as Array<{
      updateOne: {
        filter: {
          userId: Types.ObjectId;
          weekKey: string;
          timezone: string;
        };
        update: {
          $set: {
            stats: {
              postsCount: number;
              heartsGave: number;
              heartsReceived: number;
              topGivers: Types.ObjectId[];
              topReceivers: Types.ObjectId[];
            };
          };
          $setOnInsert: {
            isSeen: boolean;
          };
        };
        upsert: boolean;
      };
    }>;

    expect(operations).toHaveLength(2);

    const userAOperation = operations.find((operation) =>
      operation.updateOne.filter.userId.equals(USER_A_ID),
    );
    const userBOperation = operations.find((operation) =>
      operation.updateOne.filter.userId.equals(USER_B_ID),
    );

    expect(userAOperation?.updateOne.update.$set.stats).toEqual({
      postsCount: 2,
      heartsGave: 0,
      heartsReceived: 3,
      topGivers: [USER_B_ID],
      topReceivers: [],
    });
    expect(userBOperation?.updateOne.update.$set.stats).toEqual({
      postsCount: 0,
      heartsGave: 3,
      heartsReceived: 0,
      topGivers: [],
      topReceivers: [USER_A_ID],
    });
    expect(
      operations.every(
        (operation) =>
          operation.updateOne.upsert &&
          operation.updateOne.update.$setOnInsert.isSeen === false,
      ),
    ).toBe(true);
  });

  it('returns a public latest-recap contract without MongoDB user IDs', async () => {
    const { service, weeklyRecapModel, userModel } = createContext();

    weeklyRecapModel.findOne.mockReturnValue(
      createQuery({
        _id: RECAP_ID,
        userId: USER_A_ID,
        year: 2026,
        weekNumber: 30,
        weekKey: '2026-07-20',
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
        isSeen: false,
        stats: {
          postsCount: 2,
          heartsGave: 3,
          heartsReceived: 4,
          topGivers: [USER_B_ID],
          topReceivers: [USER_B_ID],
        },
      }),
    );
    userModel.find.mockReturnValue(
      createQuery([
        {
          _id: USER_B_ID,
          publicId: 'usr_public_b',
          username: 'user_b',
          fullname: 'User B',
          avatar: 'https://example.com/b.webp',
          streakCount: 8,
        },
      ]),
    );

    const result = await service.getLatestRecapForUser(USER_A_ID.toString());

    expect(result).toMatchObject({
      success: true,
      data: {
        id: RECAP_ID.toString(),
        weekKey: '2026-07-20',
        stats: {
          topGivers: [
            {
              id: 'usr_public_b',
              publicId: 'usr_public_b',
            },
          ],
          topReceivers: [
            {
              id: 'usr_public_b',
              publicId: 'usr_public_b',
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(USER_B_ID.toString());
    expect(userModel.find.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        isDeleted: false,
        status: 'active',
        $or: expect.any(Array),
      }),
    );
  });

  it('re-redacts recap identities that are no longer eligible at read time', async () => {
    const { service, weeklyRecapModel, userModel } = createContext();
    weeklyRecapModel.findOne.mockReturnValue(
      createQuery({
        _id: RECAP_ID,
        userId: USER_A_ID,
        year: 2026,
        weekNumber: 30,
        weekKey: '2026-07-20',
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        timezone: RECAP_TIMEZONE,
        isSeen: false,
        stats: {
          postsCount: 2,
          heartsGave: 3,
          heartsReceived: 4,
          topGivers: [USER_B_ID],
          topReceivers: [USER_B_ID],
        },
      }),
    );
    userModel.find.mockReturnValue(createQuery([]));

    const result = await service.getLatestRecapForUser(USER_A_ID.toString());

    expect(result.data?.stats.topGivers).toEqual([]);
    expect(result.data?.stats.topReceivers).toEqual([]);
    expect(result.data?.stats.postsCount).toBe(2);
    expect(result.data?.stats.heartsReceived).toBe(4);
  });

  it('marks only the authenticated user recap as seen', async () => {
    const { service, weeklyRecapModel } = createContext();

    weeklyRecapModel.updateOne.mockReturnValue(
      createQuery({
        matchedCount: 1,
        modifiedCount: 1,
      }),
    );

    await expect(
      service.markRecapAsSeen(USER_A_ID.toString(), RECAP_ID.toString()),
    ).resolves.toMatchObject({
      data: {
        modifiedCount: 1,
      },
    });

    expect(weeklyRecapModel.updateOne).toHaveBeenCalledWith(
      {
        _id: RECAP_ID,
        userId: USER_A_ID,
      },
      {
        $set: {
          isSeen: true,
        },
      },
    );
  });

  it('rejects a missing or foreign recap without leaking ownership', async () => {
    const { service, weeklyRecapModel } = createContext();

    weeklyRecapModel.updateOne.mockReturnValue(
      createQuery({
        matchedCount: 0,
        modifiedCount: 0,
      }),
    );

    await expect(
      service.markRecapAsSeen(USER_A_ID.toString(), RECAP_ID.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
