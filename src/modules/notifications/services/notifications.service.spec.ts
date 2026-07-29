import { NotFoundException, BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import {
  Notification,
  NotificationType,
  NOTIFICATION_TTL_MS,
} from '../schemas/notifications.schema';
import { User } from '../../users/schemas/user.schema';
import { NotificationsService } from './notifications.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  sort: Mock<(sort: unknown) => QueryMock<T>>;
  skip: Mock<(amount: number) => QueryMock<T>>;
  limit: Mock<(amount: number) => QueryMock<T>>;
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type NotificationModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  findOneAndUpdate: ModelMethod;
  countDocuments: ModelMethod;
  updateOne: ModelMethod;
  updateMany: ModelMethod;
  bulkWrite: ModelMethod;
};

type UserModelMock = {
  find: ModelMethod;
  exists: ModelMethod;
};

const RECIPIENT_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const ACTOR_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');
const SECOND_ACTOR_ID = new Types.ObjectId('6a4d0b24782427808adea4d5');
const POST_ID = new Types.ObjectId('6a4d0e24782427808adea59c');
const RECAP_ID = new Types.ObjectId('6a4d0e24782427808adea59d');
const NOTIFICATION_ID = new Types.ObjectId('6a4d0e24782427808adea59e');
const NOTIFICATION_PUBLIC_ID = 'noti_23456789ABCDEFGH';
const FOLLOW_NOTIFICATION_PUBLIC_ID = 'noti_3456789ABCDEFGHJ';
const RECAP_NOTIFICATION_PUBLIC_ID = 'noti_456789ABCDEFGHJK';

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.sort = jest.fn(() => query);
  query.skip = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error ? Promise.reject(error) : Promise.resolve(value),
  );

  return query;
};

const createContext = () => {
  const notificationModel: NotificationModelMock = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    bulkWrite: jest.fn(),
  };

  const userModel: UserModelMock = {
    find: jest.fn(),
    exists: jest.fn(),
  };

  const service = new NotificationsService(
    notificationModel as unknown as Model<Notification>,
    userModel as unknown as Model<User>,
  );

  return {
    service,
    notificationModel,
    userModel,
  };
};

describe('NotificationsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists one page, computes hasMore and exposes only public actor IDs', async () => {
    const { service, notificationModel, userModel } = createContext();
    const createdAt = new Date('2026-07-27T10:00:00.000Z');

    notificationModel.find.mockReturnValue(
      createQuery([
        {
          _id: NOTIFICATION_ID,
          publicId: NOTIFICATION_PUBLIC_ID,
          type: NotificationType.REACTION,
          actorIds: [ACTOR_ID],
          actorCount: 1,
          otherCount: 0,
          content: 'đã thả tim bài viết của bạn',
          targetId: POST_ID,
          targetPublicId: 'post_23456789ABCD',
          isRead: false,
          createdAt,
        },
        {
          _id: new Types.ObjectId(),
          publicId: FOLLOW_NOTIFICATION_PUBLIC_ID,
          type: NotificationType.FOLLOW,
          actorIds: [SECOND_ACTOR_ID],
          actorCount: 1,
          otherCount: 0,
          content: 'đã bắt đầu theo dõi bạn',
          targetId: SECOND_ACTOR_ID,
          isRead: true,
          createdAt,
        },
        {
          _id: new Types.ObjectId(),
          publicId: RECAP_NOTIFICATION_PUBLIC_ID,
          type: NotificationType.RECAP,
          actorIds: [],
          actorCount: 0,
          otherCount: 0,
          content: 'Weekly Recap của bạn đã sẵn sàng',
          targetId: RECAP_ID,
          isRead: false,
          createdAt,
        },
      ]),
    );
    notificationModel.countDocuments.mockReturnValue(createQuery(4));
    userModel.find.mockReturnValue(
      createQuery([
        {
          _id: ACTOR_ID,
          publicId: 'usr_actor_public',
          username: 'actor',
          fullname: 'Actor',
          avatar: 'https://example.com/actor.webp',
        },
        {
          _id: SECOND_ACTOR_ID,
          publicId: 'usr_second_actor',
          username: 'second_actor',
          fullname: 'Second Actor',
          avatar: 'https://example.com/second.webp',
        },
      ]),
    );

    const result = await service.getNotifications(RECIPIENT_ID.toString(), {
      page: 2,
      limit: 2,
      unreadOnly: true,
    });

    expect(notificationModel.find).toHaveBeenCalledWith({
      recipientId: RECIPIENT_ID,
      isRead: false,
    });
    const listQuery = notificationModel.find.mock.results[0]
      .value as QueryMock<unknown>;
    expect(listQuery.skip).toHaveBeenCalledWith(2);
    expect(listQuery.limit).toHaveBeenCalledWith(3);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 2,
      hasMore: true,
    });
    expect(result.unreadCount).toBe(4);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: NOTIFICATION_PUBLIC_ID,
      actors: [
        {
          id: 'usr_actor_public',
          publicId: 'usr_actor_public',
        },
      ],
      targetPublicId: 'post_23456789ABCD',
    });
    expect(JSON.stringify(result)).not.toContain(ACTOR_ID.toString());
    expect(result.data[0]).not.toHaveProperty('targetId');
    expect(JSON.stringify(result)).not.toContain(NOTIFICATION_ID.toString());
    expect(JSON.stringify(result)).not.toContain(POST_ID.toString());
  });

  it('marks one owned notification as read exactly once', async () => {
    const { service, notificationModel } = createContext();

    notificationModel.updateOne.mockReturnValue(
      createQuery({ modifiedCount: 1 }),
    );

    await expect(
      service.markAsRead(RECIPIENT_ID.toString(), NOTIFICATION_PUBLIC_ID),
    ).resolves.toMatchObject({
      data: {
        modifiedCount: 1,
      },
    });

    expect(notificationModel.updateOne).toHaveBeenCalledWith(
      {
        publicId: NOTIFICATION_PUBLIC_ID,
        recipientId: RECIPIENT_ID,
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      },
    );
    expect(notificationModel.findOne).not.toHaveBeenCalled();
  });

  it('keeps mark-as-read idempotent but rejects a foreign notification', async () => {
    const { service, notificationModel } = createContext();

    notificationModel.updateOne.mockReturnValue(
      createQuery({ modifiedCount: 0 }),
    );
    notificationModel.findOne
      .mockReturnValueOnce(
        createQuery({
          publicId: NOTIFICATION_PUBLIC_ID,
        }),
      )
      .mockReturnValueOnce(createQuery(null));

    await expect(
      service.markAsRead(RECIPIENT_ID.toString(), NOTIFICATION_PUBLIC_ID),
    ).resolves.toMatchObject({
      data: {
        modifiedCount: 0,
      },
    });

    await expect(
      service.markAsRead(RECIPIENT_ID.toString(), NOTIFICATION_PUBLIC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks all unread notifications for only the authenticated owner', async () => {
    const { service, notificationModel } = createContext();

    notificationModel.updateMany.mockReturnValue(
      createQuery({ modifiedCount: 3 }),
    );

    await expect(
      service.markAllAsRead(RECIPIENT_ID.toString()),
    ).resolves.toMatchObject({
      data: {
        modifiedCount: 3,
      },
    });

    expect(notificationModel.updateMany).toHaveBeenCalledWith(
      {
        recipientId: RECIPIENT_ID,
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      },
    );
  });

  it('does not create follow notification for self or disabled settings', async () => {
    const { service, notificationModel, userModel } = createContext();

    await service.createFollowNotification({
      followerId: RECIPIENT_ID,
      targetUserId: RECIPIENT_ID,
    });

    expect(userModel.exists).not.toHaveBeenCalled();

    userModel.exists.mockReturnValue(createQuery(null));

    await service.createFollowNotification({
      followerId: ACTOR_ID,
      targetUserId: RECIPIENT_ID,
    });

    expect(userModel.exists).toHaveBeenCalledWith({
      _id: RECIPIENT_ID,
      isDeleted: false,
      status: 'active',
      'notificationSettings.enabled': { $ne: false },
      'notificationSettings.follow': { $ne: false },
    });
    expect(notificationModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upserts one follow notification with a deterministic dedupe key and TTL', async () => {
    const { service, notificationModel, userModel } = createContext();
    const before = Date.now();

    userModel.exists.mockReturnValue(createQuery({ _id: RECIPIENT_ID }));
    notificationModel.findOneAndUpdate.mockReturnValue(createQuery({}));

    await service.createFollowNotification({
      followerId: ACTOR_ID,
      targetUserId: RECIPIENT_ID,
    });

    const [filter, update, options] = notificationModel.findOneAndUpdate.mock
      .calls[0] as [
      Record<string, unknown>,
      {
        $set: {
          expiresAt: Date;
          [key: string]: unknown;
        };
        $setOnInsert: {
          publicId: string;
        };
      },
      Record<string, unknown>,
    ];

    expect(filter).toEqual({
      dedupeKey: `follow:${RECIPIENT_ID.toString()}:${ACTOR_ID.toString()}`,
    });
    expect(update.$set).toMatchObject({
      recipientId: RECIPIENT_ID,
      type: NotificationType.FOLLOW,
      actorIds: [ACTOR_ID],
      actorCount: 1,
      otherCount: 0,
      isRead: false,
    });
    expect(options).toEqual({
      upsert: true,
      returnDocument: 'after',
    });
    expect(update.$set.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + NOTIFICATION_TTL_MS,
    );
    expect(update.$set.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + NOTIFICATION_TTL_MS,
    );
    expect(update.$setOnInsert.publicId).toMatch(
      /^noti_[23456789A-HJ-NP-Za-km-z]{16}$/,
    );
  });

  it('upserts a grouped reaction notification without exposing internal IDs', async () => {
    const { service, notificationModel, userModel } = createContext();

    userModel.exists.mockReturnValue(createQuery({ _id: RECIPIENT_ID }));
    notificationModel.findOneAndUpdate.mockReturnValue(createQuery({}));

    await service.createReactionNotification({
      actorId: ACTOR_ID,
      postOwnerId: RECIPIENT_ID,
      postId: POST_ID,
      postPublicId: 'post_23456789ABCD',
    });

    expect(notificationModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        dedupeKey: `reaction:${RECIPIENT_ID.toString()}:${POST_ID.toString()}`,
      },
      expect.any(Array),
      {
        upsert: true,
        returnDocument: 'after',
        updatePipeline: true,
      },
    );

    const pipeline = notificationModel.findOneAndUpdate.mock
      .calls[0][1] as Array<Record<string, unknown>>;
    expect(JSON.stringify(pipeline)).toContain('post_23456789ABCD');
    expect(JSON.stringify(pipeline)).toContain('"$slice"');
    expect(JSON.stringify(pipeline)).toContain('"$size"');

    const firstStage = pipeline[0] as {
      $set: {
        publicId: {
          $ifNull: [string, string];
        };
      };
    };

    expect(firstStage.$set.publicId.$ifNull[0]).toBe('$publicId');

    expect(firstStage.$set.publicId.$ifNull[1]).toMatch(
      /^noti_[23456789A-HJ-NP-Za-km-z]{16}$/,
    );
  });

  it('creates recap notifications only for active opted-in recipients', async () => {
    const { service, notificationModel, userModel } = createContext();
    const blockedRecipient = new Types.ObjectId();
    const weekStart = new Date('2026-07-19T17:00:00.000Z');
    const weekEnd = new Date('2026-07-26T17:00:00.000Z');

    userModel.find.mockReturnValue(createQuery([{ _id: RECIPIENT_ID }]));
    notificationModel.bulkWrite.mockImplementation(() =>
      Promise.resolve({
        upsertedCount: 1,
        matchedCount: 0,
        modifiedCount: 0,
      }),
    );

    await expect(
      service.createRecapReadyNotifications({
        targets: [
          {
            recapId: RECAP_ID,
            recipientId: RECIPIENT_ID,
            weekKey: '2026-07-20',
            weekStart,
            weekEnd,
            timezone: 'Asia/Ho_Chi_Minh',
          },
          {
            recapId: new Types.ObjectId(),
            recipientId: blockedRecipient,
            weekKey: '2026-07-20',
            weekStart,
            weekEnd,
            timezone: 'Asia/Ho_Chi_Minh',
          },
        ],
      }),
    ).resolves.toEqual({
      attempted: 1,
      created: 1,
      matched: 0,
      modified: 0,
    });

    expect(userModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        isDeleted: false,
        status: 'active',
        'notificationSettings.enabled': { $ne: false },
        'notificationSettings.recap': { $ne: false },
      }),
    );
    expect(notificationModel.bulkWrite).toHaveBeenCalledTimes(1);

    const operations = notificationModel.bulkWrite.mock.calls[0][0] as Array<{
      updateOne: {
        filter: { dedupeKey: string };
        update: {
          $setOnInsert: {
            publicId: string;
          };
        };
      };
    }>;
    expect(operations[0].updateOne.update.$setOnInsert.publicId).toMatch(
      /^noti_[23456789A-HJ-NP-Za-km-z]{16}$/,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0].updateOne.filter.dedupeKey).toBe(
      `recap:${RECIPIENT_ID.toString()}:2026-07-20:Asia/Ho_Chi_Minh`,
    );
  });

  it('rejects an internal MongoDB notification id', async () => {
    const { service, notificationModel } = createContext();

    await expect(
      service.markAsRead(RECIPIENT_ID.toString(), NOTIFICATION_ID.toString()),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(notificationModel.updateOne).not.toHaveBeenCalled();
  });
});
