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
import { OutboxStatus } from '../../src/common/outbox/outbox.constants';
import {
  OutboxEvent,
  OutboxEventSchema,
} from '../../src/common/outbox/outbox-event.schema';
import { OutboxHandlerRegistry } from '../../src/common/outbox/outbox-handler.registry';
import { OutboxProcessorService } from '../../src/common/outbox/outbox-processor.service';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { ADMIN_POST_MODERATION_EVENT_TYPE } from '../../src/modules/admin/constants/admin-post-moderation.constants';
import { ExpiredPostCleanupService } from '../../src/modules/cron/services/expired-post-cleanup.service';
import {
  Notification,
  NotificationSchema,
  NotificationType,
} from '../../src/modules/notifications/schemas/notifications.schema';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service';
import {
  Post,
  PostModerationState,
  PostSchema,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import type { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import {
  UserModerationNoticeAction,
  UserModerationNoticeStatus,
} from '../../src/modules/users/constants/user-moderation-notice.constants';
import {
  UserModerationNotice,
  UserModerationNoticeSchema,
} from '../../src/modules/users/schemas/user-moderation-notice.schema';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
import { PostModerationChangedHandler } from '../../src/modules/users/services/user-moderation-notice.handlers';
import { UserModerationNoticeService } from '../../src/modules/users/services/user-moderation-notice.service';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const PREFIX = 'betta_post_notice_it_';
const databaseName =
  PREFIX + process.pid + '_' + randomUUID().replace(/-/gu, '').slice(0, 6);

jest.setTimeout(120_000);

describe('Admin Post moderation notice MongoDB integration', () => {
  let connection: Connection;
  let users: Model<User>;
  let posts: Model<Post>;
  let notices: Model<UserModerationNotice>;
  let notifications: Model<Notification>;
  let events: Model<OutboxEvent>;
  let outbox: OutboxService;
  let processor: OutboxProcessorService;
  let cleanup: ExpiredPostCleanupService;
  const deleteImages = jest.fn<() => Promise<void>>();

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(URI_ENV + ' chua duoc cau hinh');
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(CONFIRM_ENV + '=YES la bat buoc');
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI khong duoc trung runtime URI');
    }
    if (!databaseName.startsWith(PREFIX) || databaseName.length > 38) {
      throw new Error('Ten database khong an toan');
    }

    connection = createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    });
    await connection.asPromise();
    users = connection.model(User.name, UserSchema.clone());
    posts = connection.model(Post.name, PostSchema.clone());
    notices = connection.model(
      UserModerationNotice.name,
      UserModerationNoticeSchema.clone(),
    );
    notifications = connection.model(
      Notification.name,
      NotificationSchema.clone(),
    );
    events = connection.model(OutboxEvent.name, OutboxEventSchema.clone());
    await Promise.all([
      users.syncIndexes(),
      posts.syncIndexes(),
      notices.syncIndexes(),
      notifications.syncIndexes(),
      events.syncIndexes(),
    ]);

    outbox = new OutboxService(events);
    const notificationService = new NotificationsService(
      notifications,
      users,
      posts,
    );
    const noticeService = new UserModerationNoticeService(
      notices,
      users,
      notificationService,
      posts,
    );
    const registry = new OutboxHandlerRegistry();
    new PostModerationChangedHandler(registry, noticeService).onModuleInit();
    processor = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
    cleanup = new ExpiredPostCleanupService(posts, users, {
      deleteImages,
    } as unknown as UploadsService);
  });

  beforeEach(async () => {
    deleteImages.mockReset();
    deleteImages.mockResolvedValue(undefined);
    await Promise.all([
      users.collection.deleteMany({}),
      posts.collection.deleteMany({}),
      notices.collection.deleteMany({}),
      notifications.collection.deleteMany({}),
      events.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (!connection.name.startsWith(PREFIX)) {
        throw new Error('Tu choi xoa database: ' + connection.name);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('persists notice and acknowledges it before physical cleanup', async () => {
    const user = await users.create({
      publicId: generateUserPublicId(),
      username: 'post_notice_' + randomUUID().slice(0, 8),
      fullname: 'Post Notice User',
      phone: '09' + String(Date.now()).slice(-8),
      email: randomUUID() + '@user.test',
      status: 'active',
      isDeleted: false,
      restriction: null,
      postsCount: 1,
    });
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: user._id,
      content: 'hidden Post waiting for mandatory notice',
      images: [],
      expireAt: new Date(Date.now() - 60_000),
      moderationState: PostModerationState.HIDDEN,
      moderationVersion: 1,
      moderationNoticeVersion: 0,
      isDeletedByAdmin: true,
    });

    const session = await connection.startSession();
    let eventPublicId = '';
    try {
      await session.withTransaction(async () => {
        eventPublicId = await outbox.enqueue({
          eventType: ADMIN_POST_MODERATION_EVENT_TYPE,
          dedupeKey: 'post-moderation:' + post.publicId + ':1',
          aggregateType: 'post',
          aggregatePublicId: post.publicId,
          payload: {
            schemaVersion: 1,
            postPublicId: post.publicId,
            state: PostModerationState.HIDDEN,
            publicReasonCode: 'community_policy_review',
            publicMessage:
              'Trạng thái hiển thị nội dung của bạn đã được cập nhật',
            moderationVersion: 1,
            cleanupRequested: false,
          },
          mongoSession: session,
        });
      });
    } finally {
      await session.endSession();
    }

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
    await expect(posts.exists({ _id: post._id })).resolves.not.toBeNull();

    await expect(processor.drain()).resolves.toBe(1);
    const [event, notice, notification, acknowledged] = await Promise.all([
      events.findOne({ publicId: eventPublicId }).lean().exec(),
      notices.findOne({ sourceEventPublicId: eventPublicId }).lean().exec(),
      notifications.findOne({ recipientId: user._id }).lean().exec(),
      posts.findById(post._id).select('+moderationNoticeVersion').lean().exec(),
    ]);
    expect(event?.status).toBe(OutboxStatus.PUBLISHED);
    expect(notice).toMatchObject({
      targetPublicId: user.publicId,
      noticeType: 'SYSTEM_MODERATION',
      publicAction: UserModerationNoticeAction.POST_HIDDEN,
      publicReasonCode: 'community_policy_review',
      status: UserModerationNoticeStatus.ACTIVE,
    });
    expect(notification).toMatchObject({
      type: NotificationType.SYSTEM_MODERATION,
      actorIds: [],
      moderation: {
        action: UserModerationNoticeAction.POST_HIDDEN,
        publicReasonCode: 'community_policy_review',
      },
    });
    expect(acknowledged?.moderationNoticeVersion).toBe(1);
    expect(JSON.stringify({ event, notice, notification })).not.toMatch(
      /actorPublicId|adminPublicId|reasonNote|authorId|publicId.*cloudinary/iu,
    );

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 1,
      deleted: 1,
      failed: 0,
    });
    await expect(posts.exists({ _id: post._id })).resolves.toBeNull();
  });
});
