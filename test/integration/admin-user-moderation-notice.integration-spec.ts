import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createConnection, type Connection, type Model } from 'mongoose';
import {
  OutboxEvent,
  OutboxEventSchema,
} from '../../src/common/outbox/outbox-event.schema';
import { OutboxHandlerRegistry } from '../../src/common/outbox/outbox-handler.registry';
import { OutboxProcessorService } from '../../src/common/outbox/outbox-processor.service';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { OutboxStatus } from '../../src/common/outbox/outbox.constants';
import {
  ADMIN_USER_RESTRICTION_EVENT_TYPE,
  AdminUserRestrictionOperation,
} from '../../src/modules/admin/constants/admin-user-restriction.constants';
import {
  Notification,
  NotificationSchema,
  NotificationType,
  NOTIFICATION_TTL_MS,
} from '../../src/modules/notifications/schemas/notifications.schema';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service';
import { Post, PostSchema } from '../../src/modules/posts/schemas/post.schema';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import {
  USER_MODERATION_NOTICE_RETENTION_INDEX,
  USER_MODERATION_NOTICE_SOURCE_EVENT_INDEX,
  UserModerationNoticeAction,
  UserModerationNoticeStatus,
} from '../../src/modules/users/constants/user-moderation-notice.constants';
import {
  UserModerationNotice,
  UserModerationNoticeSchema,
} from '../../src/modules/users/schemas/user-moderation-notice.schema';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
import {
  UserDeletionChangedHandler,
  UserRestrictionChangedHandler,
} from '../../src/modules/users/services/user-moderation-notice.handlers';
import { UserModerationNoticeService } from '../../src/modules/users/services/user-moderation-notice.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_usr_notice_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID()
  .replace(/-/gu, '')
  .slice(0, 6)}`;

jest.setTimeout(90_000);

describe('User moderation notice MongoDB integration', () => {
  let connection: Connection;
  let users: Model<User>;
  let notices: Model<UserModerationNotice>;
  let notifications: Model<Notification>;
  let posts: Model<Post>;
  let events: Model<OutboxEvent>;
  let outbox: OutboxService;
  let processor: OutboxProcessorService;
  let noticeService: UserModerationNoticeService;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if ([process.env.DATABASE_URL, process.env.MONGODB_URI].includes(uri)) {
      throw new Error('Integration URI không được trùng runtime URI');
    }
    connection = createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    });
    await connection.asPromise();
    users = connection.model(User.name, UserSchema.clone());
    notices = connection.model(
      UserModerationNotice.name,
      UserModerationNoticeSchema.clone(),
    );
    notifications = connection.model(
      Notification.name,
      NotificationSchema.clone(),
    );
    posts = connection.model(Post.name, PostSchema.clone());
    events = connection.model(OutboxEvent.name, OutboxEventSchema.clone());
    await Promise.all([
      users.syncIndexes(),
      notices.syncIndexes(),
      notifications.syncIndexes(),
      posts.syncIndexes(),
      events.syncIndexes(),
    ]);

    outbox = new OutboxService(events);
    const notificationService = new NotificationsService(
      notifications,
      users,
      posts,
    );
    noticeService = new UserModerationNoticeService(
      notices,
      users,
      notificationService,
    );
    const registry = new OutboxHandlerRegistry();
    new UserRestrictionChangedHandler(registry, noticeService).onModuleInit();
    new UserDeletionChangedHandler(registry, noticeService).onModuleInit();
    processor = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
  });

  beforeEach(async () => {
    await Promise.all([
      users.collection.deleteMany({}),
      notices.collection.deleteMany({}),
      notifications.collection.deleteMany({}),
      events.collection.deleteMany({}),
    ]);
    await users.create({
      publicId: 'usr_23456789AB',
      username: 'notice.user',
      fullname: 'Notice User',
      phone: '0394281845',
      email: 'notice.user@betta.test',
    });
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Từ chối xóa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  const enqueueRestriction = async (
    operation: AdminUserRestrictionOperation,
    version: number,
  ): Promise<string> => {
    const session = await connection.startSession();
    try {
      let publicId = '';
      await session.withTransaction(async () => {
        publicId = await outbox.enqueue({
          eventType: ADMIN_USER_RESTRICTION_EVENT_TYPE,
          dedupeKey: `user-restriction:usr_23456789AB:${version}`,
          aggregateType: 'user',
          aggregatePublicId: 'usr_23456789AB',
          payload: {
            schemaVersion: 1,
            operation,
            userPublicId: 'usr_23456789AB',
            restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
            restriction:
              operation === AdminUserRestrictionOperation.APPLY
                ? {
                    type: UserRestrictionType.TEMPORARY_SUSPENSION,
                    effectiveAt: '2026-08-20T01:00:00.000Z',
                    expiresAt: '2026-08-21T01:00:00.000Z',
                    supportReference: 'sup_23456789ABCD',
                    publicReasonCode: 'community_policy_review',
                  }
                : null,
            beforeVersion: version - 1,
            afterVersion: version,
          },
          mongoSession: session,
        });
      });
      return publicId;
    } finally {
      await session.endSession();
    }
  };

  it('creates required unique and retention indexes and rejects mutation', async () => {
    type ListedIndex = Readonly<{
      name: string;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    const indexes = (await notices.collection
      .listIndexes()
      .toArray()) as unknown as ListedIndex[];
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get(USER_MODERATION_NOTICE_SOURCE_EVENT_INDEX)?.unique).toBe(
      true,
    );
    expect(
      byName.get(USER_MODERATION_NOTICE_RETENTION_INDEX)?.expireAfterSeconds,
    ).toBe(0);

    await enqueueRestriction(AdminUserRestrictionOperation.APPLY, 1);
    await processor.drain();
    await expect(
      notices.updateOne(
        {},
        { $set: { status: UserModerationNoticeStatus.RESOLVED } },
      ),
    ).rejects.toThrow('append-only');
  });

  it('publishes APPLY only after storing one safe durable notice', async () => {
    const eventPublicId = await enqueueRestriction(
      AdminUserRestrictionOperation.APPLY,
      1,
    );
    await expect(processor.drain()).resolves.toBe(1);

    const [event, notice, notificationCount] = await Promise.all([
      events.findOne({ publicId: eventPublicId }).lean().exec(),
      notices.findOne({ sourceEventPublicId: eventPublicId }).lean().exec(),
      notifications.countDocuments({}).exec(),
    ]);
    expect(event?.status).toBe(OutboxStatus.PUBLISHED);
    expect(notice).toMatchObject({
      noticeType: 'SYSTEM_MODERATION',
      publicAction: UserModerationNoticeAction.TEMPORARY_SUSPENSION_APPLIED,
      status: UserModerationNoticeStatus.ACTIVE,
      supportReference: 'sup_23456789ABCD',
      publicReasonCode: 'community_policy_review',
    });
    expect(JSON.stringify(notice)).not.toMatch(
      /actor|reasonNote|evidence|password|token/iu,
    );
    expect(notificationCount).toBe(0);
  });

  it('is idempotent and creates one mandatory notification on REMOVE', async () => {
    const eventPublicId = await enqueueRestriction(
      AdminUserRestrictionOperation.REMOVE,
      2,
    );
    await processor.drain();
    const claimed = await events
      .findOne({ publicId: eventPublicId })
      .lean()
      .exec();
    if (!claimed) throw new Error('Missing event fixture');
    await noticeService.consumeRestrictionEvent({
      publicId: claimed.publicId,
      schemaVersion: claimed.schemaVersion,
      eventType: claimed.eventType,
      dedupeKey: claimed.dedupeKey,
      aggregateType: claimed.aggregateType,
      aggregatePublicId: claimed.aggregatePublicId,
      payload: claimed.payload,
      correlationId: claimed.correlationId,
      attempt: claimed.attempt,
      occurredAt: claimed.occurredAt,
    });

    await expect(
      notices.countDocuments({ sourceEventPublicId: eventPublicId }),
    ).resolves.toBe(1);
    const notification = await notifications.findOne({}).lean().exec();
    const notice = await notices
      .findOne({ sourceEventPublicId: eventPublicId })
      .lean()
      .exec();
    await expect(notifications.countDocuments({})).resolves.toBe(1);
    expect(notification).toMatchObject({
      type: NotificationType.SYSTEM_MODERATION,
      actorIds: [],
      moderation: {
        action: UserModerationNoticeAction.TEMPORARY_SUSPENSION_REMOVED,
      },
    });
    expect(JSON.stringify(notification)).not.toMatch(
      /actorPublicId|reasonNote|evidence/iu,
    );
    if (!notification || !notice) throw new Error('Missing notice fixture');
    const notificationLifetimeMs =
      notification.expiresAt.getTime() - notification.createdAt.getTime();
    expect(notificationLifetimeMs).toBeGreaterThanOrEqual(
      NOTIFICATION_TTL_MS - 5_000,
    );
    expect(notificationLifetimeMs).toBeLessThanOrEqual(NOTIFICATION_TTL_MS);
    expect(notice.retentionExpiresAt.getTime()).toBeGreaterThan(
      notification.expiresAt.getTime(),
    );
  });
});
