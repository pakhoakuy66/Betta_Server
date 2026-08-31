import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, type Model } from 'mongoose';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { CanonicalModerationReasonCode } from '../../src/common/moderation/moderation-reason.constants';
import { AdminPostModerationOperation } from '../../src/modules/admin/constants/admin-post-moderation.constants';
import { AdminPostLifecycleService } from '../../src/modules/admin/services/admin-post-lifecycle.service';
import { AdminReportTargetMutationService } from '../../src/modules/admin/services/admin-report-target-mutation.service';
import { ExpiredPostCleanupService } from '../../src/modules/cron/services/expired-post-cleanup.service';
import {
  Post,
  PostModerationState,
  PostSchema,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import { ReportTargetType } from '../../src/modules/reports/schemas/report.schema';
import type { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_apml_it_';
const databaseName =
  DATABASE_PREFIX +
  process.pid +
  '_' +
  randomUUID().replace(/-/gu, '').slice(0, 8);

jest.setTimeout(120_000);

describe('Admin Post lifecycle MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let posts: Model<Post>;
  let users: Model<User>;
  let lifecycle: AdminPostLifecycleService;
  const enqueue = jest.fn<(input: unknown) => Promise<void>>();

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

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        MongooseModule.forFeature([
          { name: Post.name, schema: PostSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [
        AdminPostLifecycleService,
        { provide: OutboxService, useValue: { enqueue } },
      ],
    }).compile();
    connection = moduleRef.get<Connection>(getConnectionToken());
    posts = moduleRef.get<Model<Post>>(getModelToken(Post.name));
    users = moduleRef.get<Model<User>>(getModelToken(User.name));
    lifecycle = moduleRef.get(AdminPostLifecycleService);
    await Promise.all([posts.syncIndexes(), users.syncIndexes()]);
  });

  beforeEach(async () => {
    enqueue.mockReset();
    enqueue.mockResolvedValue(undefined);
    await Promise.all([
      posts.collection.deleteMany({}),
      users.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error('Tu choi xoa database: ' + connection.name);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const createAuthor = async () =>
    users.create({
      publicId: generateUserPublicId(),
      username: 'post_mod_' + randomUUID().slice(0, 8),
      fullname: 'Post Moderation Author',
      phone: '09' + String(Date.now()).slice(-8),
      email: randomUUID() + '@user.test',
      status: 'active',
      isDeleted: false,
      restriction: null,
      version: 0,
      authzVersion: 0,
    });

  const createPost = async (state = PostModerationState.ACTIVE) => {
    const author = await createAuthor();
    return posts.create({
      publicId: generatePostPublicId(),
      authorId: author._id,
      content: 'moderation integration post',
      images: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/post.webp',
          publicId: 'betta/posts/' + randomUUID(),
        },
      ],
      expireAt: new Date(Date.now() + 60_000),
      moderationState: state,
      moderationVersion: state === PostModerationState.ACTIVE ? 0 : 1,
      isDeletedByAdmin: state !== PostModerationState.ACTIVE,
    });
  };

  it('hides, restores and terminal-deletes with monotonic CAS', async () => {
    const post = await createPost();
    const hide = await connection.transaction(async (session) => {
      const transition = await lifecycle.transition(
        {
          actorPublicId: 'adm_5mUfVZfKbnXM',
          postPublicId: post.publicId,
          operation: AdminPostModerationOperation.HIDE,
          expectedModerationVersion: 0,
          reasonCode: CanonicalModerationReasonCode.MODERATION_POLICY,
          reasonNote: 'private internal moderation note',
        },
        session,
      );
      await lifecycle.enqueue({
        transition,
        operation: AdminPostModerationOperation.HIDE,
        mongoSession: session,
      });
      return transition;
    });
    expect(hide).toMatchObject({
      afterState: PostModerationState.HIDDEN,
      beforeVersion: 0,
      afterVersion: 1,
      publicReasonCode: 'community_policy_review',
    });
    const enqueuedInput = enqueue.mock.calls[0]?.[0] as
      | Readonly<{ payload?: unknown }>
      | undefined;
    const publicPayload = JSON.stringify(enqueuedInput?.payload);
    expect(publicPayload).toContain('community_policy_review');
    expect(publicPayload).not.toContain('private internal moderation note');
    expect(publicPayload).not.toContain('adm_5mUfVZfKbnXM');
    expect(publicPayload).not.toContain(post.authorId.toHexString());

    const restore = await connection.transaction((session) =>
      lifecycle.transition(
        {
          actorPublicId: 'adm_5mUfVZfKbnXM',
          postPublicId: post.publicId,
          operation: AdminPostModerationOperation.RESTORE,
          expectedModerationVersion: 1,
          reasonCode: CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
        },
        session,
      ),
    );
    expect(restore).toMatchObject({
      afterState: PostModerationState.ACTIVE,
      afterVersion: 2,
      publicReasonCode: 'content_visibility_updated',
    });

    const deleted = await connection.transaction((session) =>
      lifecycle.transition(
        {
          actorPublicId: 'adm_5mUfVZfKbnXM',
          postPublicId: post.publicId,
          operation: AdminPostModerationOperation.TERMINAL_DELETE,
          expectedModerationVersion: 2,
          reasonCode: CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
        },
        session,
      ),
    );
    expect(deleted).toMatchObject({
      afterState: PostModerationState.TERMINAL_DELETED,
      afterVersion: 3,
    });
    await expect(
      connection.transaction((session) =>
        lifecycle.transition(
          {
            actorPublicId: 'adm_5mUfVZfKbnXM',
            postPublicId: post.publicId,
            operation: AdminPostModerationOperation.RESTORE,
            expectedModerationVersion: 3,
            reasonCode:
              CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
          },
          session,
        ),
      ),
    ).rejects.toThrow('Chỉ Post hidden mới được khôi phục');
  });

  it('rejects stale version, expired post and reason/action mismatch', async () => {
    const post = await createPost();
    await expect(
      connection.transaction((session) =>
        lifecycle.transition(
          {
            actorPublicId: 'adm_5mUfVZfKbnXM',
            postPublicId: post.publicId,
            operation: AdminPostModerationOperation.HIDE,
            expectedModerationVersion: 9,
            reasonCode: CanonicalModerationReasonCode.MODERATION_POLICY,
          },
          session,
        ),
      ),
    ).rejects.toThrow('Post đã thay đổi');

    await expect(
      connection.transaction((session) =>
        lifecycle.transition(
          {
            actorPublicId: 'adm_5mUfVZfKbnXM',
            postPublicId: post.publicId,
            operation: AdminPostModerationOperation.HIDE,
            expectedModerationVersion: 0,
            reasonCode: CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
          },
          session,
        ),
      ),
    ).rejects.toThrow('Reason code không hợp lệ');
  });

  it('blocks restore when author is ineligible or asset references are missing', async () => {
    const post = await createPost(PostModerationState.HIDDEN);
    await users.updateOne(
      { _id: post.authorId },
      { $set: { isDeleted: true } },
    );
    await expect(
      connection.transaction((session) =>
        lifecycle.transition(
          {
            actorPublicId: 'adm_5mUfVZfKbnXM',
            postPublicId: post.publicId,
            operation: AdminPostModerationOperation.RESTORE,
            expectedModerationVersion: 1,
            reasonCode:
              CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
          },
          session,
        ),
      ),
    ).rejects.toThrow('Author không còn đủ điều kiện');
  });

  it('does not physically clean a moderated expired Post before notice acknowledgement', async () => {
    const author = await createAuthor();
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: author._id,
      content: 'hidden near expiry',
      images: [],
      expireAt: new Date(Date.now() - 60_000),
      moderationState: PostModerationState.HIDDEN,
      moderationVersion: 1,
      moderationNoticeVersion: 0,
      isDeletedByAdmin: true,
    });
    const deleteImages = jest.fn<() => Promise<void>>();
    deleteImages.mockResolvedValue(undefined);
    const cleanup = new ExpiredPostCleanupService(posts, users, {
      deleteImages,
    } as unknown as UploadsService);

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
    await expect(posts.exists({ _id: post._id })).resolves.not.toBeNull();

    await posts.updateOne(
      { _id: post._id },
      { $set: { moderationNoticeVersion: 1 } },
    );
    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 1,
      deleted: 1,
      failed: 0,
    });
    await expect(posts.exists({ _id: post._id })).resolves.toBeNull();
  });

  it('classifies explicit HIDDEN as available to MOD-04 despite compatibility flag', async () => {
    const post = await createPost(PostModerationState.HIDDEN);
    const targets = new AdminReportTargetMutationService(
      posts,
      users,
      {} as never,
      {} as never,
      {} as never,
      lifecycle,
    );
    const inspected = await connection.transaction((session) =>
      targets.inspect(
        {
          _id: post._id,
          publicId: 'rpt_23456789ABCDEFGH',
          reporterId: post.authorId,
          targetType: ReportTargetType.POST,
          targetId: post._id,
          targetSnapshot: { publicId: post.publicId },
          version: 0,
        },
        new Date(),
        session,
      ),
    );
    expect(inspected).toMatchObject({
      availability: 'AVAILABLE',
      publicId: post.publicId,
    });
  });
});
