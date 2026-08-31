import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
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
import { OutboxEvent } from '../../src/common/outbox/outbox-event.schema';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAuditActorType } from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import {
  ADMIN_POST_MODERATION_FAILURE_INJECTOR,
  ADMIN_POST_MODERATION_IDEMPOTENCY_INDEX,
  ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_INDEX,
  AdminPostModerationFailureStep,
  AdminPostModerationOperation,
} from '../../src/modules/admin/constants/admin-post-moderation.constants';
import type {
  AdminPostModerationActor,
  AdminPostModerationFailureInjector,
  UpdateAdminPostModerationInput,
} from '../../src/modules/admin/interfaces/admin-post-moderation.interface';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminPostModerationRequest } from '../../src/modules/admin/schemas/admin-post-moderation-request.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminPostModerationService } from '../../src/modules/admin/services/admin-post-moderation.service';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';
import {
  Post,
  PostModerationState,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import { User } from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const PREFIX = 'betta_post_mod_it_';
const dbName =
  PREFIX + process.pid + '_' + randomUUID().replace(/-/gu, '').slice(0, 6);

const secretValues = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: 'post-mod-it-' + index,
        keyBase64: Buffer.alloc(32, index + 101).toString('base64'),
      },
      previous: [],
    }),
  ]),
) as Readonly<Record<string, string>>;
const secrets = createAdminSecrets({
  source: { get: (key: string): unknown => secretValues[key] },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});

class FailureInjector implements AdminPostModerationFailureInjector {
  step?: AdminPostModerationFailureStep;
  hit(step: AdminPostModerationFailureStep): void {
    if (step === this.step) {
      throw new Error('Injected failure: ' + step);
    }
  }
}

jest.setTimeout(180_000);

describe('Admin Post moderation idempotency MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let posts: Model<Post>;
  let users: Model<User>;
  let audits: Model<AdminAuditEvent>;
  let outbox: Model<OutboxEvent>;
  let requests: Model<AdminPostModerationRequest>;
  let service: AdminPostModerationService;
  const failure = new FailureInjector();

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
    if (!dbName.startsWith(PREFIX) || dbName.length > 38) {
      throw new Error('Ten database khong an toan');
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(uri, {
          dbName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        OutboxModule,
        AdminModule,
      ],
    })
      .overrideProvider(ADMIN_SECRETS)
      .useValue(secrets)
      .overrideProvider(ADMIN_POST_MODERATION_FAILURE_INJECTOR)
      .useValue(failure)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    sessions = moduleRef.get(getModelToken(AdminSession.name));
    posts = moduleRef.get(getModelToken(Post.name));
    users = moduleRef.get(getModelToken(User.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outbox = moduleRef.get(getModelToken(OutboxEvent.name));
    requests = moduleRef.get(getModelToken(AdminPostModerationRequest.name));
    service = moduleRef.get(AdminPostModerationService);
    await Promise.all(
      [accounts, sessions, posts, users, audits, outbox, requests].map(
        (model) => model.syncIndexes(),
      ),
    );
  });

  beforeEach(async () => {
    failure.step = undefined;
    await Promise.all([
      accounts.deleteMany({}),
      sessions.deleteMany({}),
      posts.deleteMany({}),
      users.deleteMany({}),
      audits.collection.deleteMany({}),
      outbox.deleteMany({}),
      requests.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(PREFIX)) {
        throw new Error('Tu choi xoa database: ' + connection.name);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const actor = async (): Promise<AdminPostModerationActor> => {
    const account = await accounts.create({
      publicId: generateAdminPublicId(),
      email: randomUUID() + '@betta.test',
      username: 'postmod_' + randomUUID().replace(/-/gu, '').slice(0, 12),
      displayName: 'Post Moderation Operator',
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: '$2b$12$' + 'a'.repeat(53),
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'atotp_v1.integration.post-moderation',
      activationGrantConsumedAt: new Date(),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      version: 0,
      lockedAt: null,
      deletedAt: null,
    });
    const session = await sessions.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      refreshTokenHash: 'sha256-v1:' + 'a'.repeat(64),
      deviceLabel: 'Integration',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 180_000),
      revokedAt: null,
      revokeReason: null,
    });
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: account._id,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: AdminRole.SUPER_ADMIN,
      permission: AdminPermission.POSTS_HIDE,
      permissionVersion: 1,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
    });
  };

  const post = async (): Promise<Post> => {
    const user = await users.create({
      publicId: generateUserPublicId(),
      username: 'author_' + randomUUID().slice(0, 8),
      fullname: 'Post Author',
      phone: '09' + String(Date.now()).slice(-8),
      email: randomUUID() + '@user.test',
      status: 'active',
      isDeleted: false,
      restriction: null,
      version: 0,
      authzVersion: 0,
    });
    return posts.create({
      publicId: generatePostPublicId(),
      authorId: user._id,
      content: 'post moderation idempotency integration',
      images: [],
      expireAt: new Date(Date.now() + 300_000),
      moderationState: PostModerationState.ACTIVE,
      moderationVersion: 0,
      moderationNoticeVersion: 0,
      isDeletedByAdmin: false,
    });
  };

  const hideInput = (
    moderationActor: AdminPostModerationActor,
    target: Post,
    key: string,
  ): UpdateAdminPostModerationInput => ({
    actor: moderationActor,
    postPublicId: target.publicId,
    operation: AdminPostModerationOperation.HIDE,
    expectedModerationVersion: 0,
    reasonCode: 'moderation_policy',
    reasonNote: 'Hide after confirmed moderation review',
    correlationId: 'adm-mod-06-concurrency-0001',
    idempotencyKey: key,
  });

  it('creates the required unique and TTL idempotency indexes', async () => {
    type ListedIndex = Readonly<{
      name: string;
      key: Readonly<Record<string, number>>;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    const indexes = (await requests.collection
      .listIndexes()
      .toArray()) as unknown as ListedIndex[];
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get(ADMIN_POST_MODERATION_IDEMPOTENCY_INDEX)).toMatchObject({
      unique: true,
      key: { idempotencyHash: 1 },
    });
    expect(
      byName.get(ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_INDEX),
    ).toMatchObject({
      expireAfterSeconds: 0,
      key: { idempotencyExpiresAt: 1 },
    });
  });

  it('converges concurrent same-key same-payload requests to one commit', async () => {
    const moderationActor = await actor();
    const target = await post();
    const input = hideInput(
      moderationActor,
      target,
      'adm-mod-06-same-key-0001',
    );

    const [first, second] = await Promise.all([
      service.update(input),
      service.update(input),
    ]);

    expect(second).toEqual(first);
    expect(first.post).toMatchObject({
      publicId: target.publicId,
      state: PostModerationState.HIDDEN,
      moderationVersion: 1,
    });
    await expect(
      Promise.all([
        requests.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({
          aggregatePublicId: target.publicId,
          eventType: 'moderation.post.state_changed',
        }),
      ]),
    ).resolves.toEqual([1, 1, 1]);
  });

  it('rejects same key with a different fingerprint', async () => {
    const moderationActor = await actor();
    const target = await post();
    const input = hideInput(
      moderationActor,
      target,
      'adm-mod-06-conflict-key01',
    );
    await service.update(input);
    await expect(
      service.update({
        ...input,
        reasonNote: 'Different moderation reason note',
      }),
    ).rejects.toThrow('Idempotency-Key đã được dùng cho payload khác');
  });

  it('allows only one winner for different keys with the same CAS version', async () => {
    const moderationActor = await actor();
    const target = await post();
    const settled = await Promise.allSettled([
      service.update(
        hideInput(moderationActor, target, 'adm-mod-06-cas-key-00001'),
      ),
      service.update(
        hideInput(moderationActor, target, 'adm-mod-06-cas-key-00002'),
      ),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    await expect(requests.countDocuments({})).resolves.toBe(1);
  });

  it.each([
    AdminPostModerationFailureStep.AFTER_RESERVATION,
    AdminPostModerationFailureStep.AFTER_TARGET,
    AdminPostModerationFailureStep.AFTER_OUTBOX,
    AdminPostModerationFailureStep.AFTER_AUDIT,
    AdminPostModerationFailureStep.AFTER_REQUEST,
  ])('rolls back all state at %s', async (step) => {
    const moderationActor = await actor();
    const target = await post();
    failure.step = step;
    await expect(
      service.update(
        hideInput(
          moderationActor,
          target,
          'adm-mod-06-rollback-' + step.toLowerCase(),
        ),
      ),
    ).rejects.toThrow('Injected failure');

    const storedPost = await posts
      .findById(target._id)
      .select('+moderationState +moderationVersion')
      .lean()
      .exec();
    expect(storedPost).toMatchObject({
      moderationState: PostModerationState.ACTIVE,
      moderationVersion: 0,
      isDeletedByAdmin: false,
    });
    await expect(
      Promise.all([
        requests.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({ aggregatePublicId: target.publicId }),
      ]),
    ).resolves.toEqual([0, 0, 0]);
  });
});
