import { SponsoredPostMutationService } from '../../src/modules/sponsored-posts/sponsored-post-mutation.service';
import { SponsoredMutationReceipt } from '../../src/modules/sponsored-posts/sponsored-mutation-receipt.schema';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { createConnection, type Connection, type Model, Types } from 'mongoose';
import {
  ADMIN_POLICY,
  createAdminPolicy,
} from '../../src/modules/admin/config/admin-policy.config';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAuditAction } from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { type AdminRequestPrincipal } from '../../src/modules/admin/types/admin-authenticated-request';
import {
  SPONSORED_CLOCK,
  SPONSORED_DAY_MS as DAY,
  SponsoredAssetHealth as Health,
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from '../../src/modules/sponsored-posts/sponsored-post.constants';
import { SponsoredPost } from '../../src/modules/sponsored-posts/sponsored-post.schema';
import { SponsoredPostWriterService } from '../../src/modules/sponsored-posts/sponsored-post-writer.service';
import { SponsoredPostsModule } from '../../src/modules/sponsored-posts/sponsored-posts.module';

const databaseName = `betta_spon_mut_it_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const context = {
  reasonCode: 'campaign_review',
  correlationId: 'corr_spon_core_integration_0001',
};
jest.setTimeout(120_000);
@Module({})
class FixtureConnectionModule {}

describe('SADM-SPON-08 mutation transactions', () => {
  let moduleRef: TestingModule | undefined;
  let connection: Connection | undefined;
  let posts: Model<SponsoredPost>;
  let audits: Model<AdminAuditEvent>;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let writer: SponsoredPostWriterService;
  let mutations: SponsoredPostMutationService;
  let receipts: Model<SponsoredMutationReceipt>;
  let audit: AdminAuditService;
  let currentTime: Date;
  let actor: AdminRequestPrincipal;
  const draft = () => ({
    content: 'Synthetic sponsored integration fixture',
    images: [],
    destinationUrl: 'https://example.com/offer',
    cta: 'Learn more',
    startAt: new Date(currentTime),
    endAt: new Date(currentTime.getTime() + 2 * DAY),
  });
  const create = () => writer.createDraft(actor, draft(), context);
  const move = (id: string, version: number, action: Action) =>
    writer.transition(actor, id, version, action, context);
  // Raw writes below are test fixtures only, never a production asset-health API.
  const healthy = (id: string) =>
    posts.collection.updateOne(
      { publicId: id },
      { $set: { assetHealth: Health.HEALTHY } },
    );

  beforeAll(async () => {
    const uri = process.env.MONGODB_INTEGRATION_URI?.trim();
    if (!uri || process.env.RUN_MONGODB_INTEGRATION_TESTS !== 'YES') {
      throw new Error(
        'Dedicated integration URI and explicit YES confirmation are required',
      );
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI].some(
        (value) => value?.trim() === uri,
      )
    ) {
      throw new Error('Integration URI must not match runtime URI');
    }
    try {
      connection = await createConnection(uri, {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 15000,
      }).asPromise();
      moduleRef = await Test.createTestingModule({
        imports: [
          {
            module: FixtureConnectionModule,
            global: true,
            providers: [
              { provide: getConnectionToken(), useValue: connection },
            ],
            exports: [getConnectionToken()],
          },
          SponsoredPostsModule,
        ],
      })
        .overrideProvider(ADMIN_POLICY)
        .useValue(createAdminPolicy({ get: () => undefined }))
        .overrideProvider(SPONSORED_CLOCK)
        .useValue(() => new Date(currentTime))
        .compile();
      connection = moduleRef.get<Connection>(getConnectionToken());
      posts = moduleRef.get<Model<SponsoredPost>>(
        getModelToken(SponsoredPost.name),
      );
      audits = moduleRef.get<Model<AdminAuditEvent>>(
        getModelToken(AdminAuditEvent.name),
      );
      accounts = moduleRef.get<Model<AdminAccount>>(
        getModelToken(AdminAccount.name),
      );
      sessions = moduleRef.get<Model<AdminSession>>(
        getModelToken(AdminSession.name),
      );
      writer = moduleRef.get(SponsoredPostWriterService);
      audit = moduleRef.get(AdminAuditService);
      mutations = moduleRef.get(SponsoredPostMutationService);
      receipts = moduleRef.get<Model<SponsoredMutationReceipt>>(
        getModelToken(SponsoredMutationReceipt.name),
      );
      await receipts.createIndexes();
      // createIndexes only adds; never drop existing indexes using syncIndexes in a rollout.
      await posts.createIndexes();
      await audits.createIndexes();
      await accounts.createCollection();
      await sessions.createCollection();
    } catch {
      if (
        connection &&
        Number(connection.readyState) === 1 &&
        connection.name === databaseName
      ) {
        try {
          await connection.dropDatabase();
        } finally {
          await connection.close();
        }
      }
      if (moduleRef) await moduleRef.close();
      moduleRef = undefined;
      throw new Error('SPONSORED_INTEGRATION_SETUP_FAILED');
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const model of [posts, audits, accounts, sessions, receipts])
      await model.collection.deleteMany({});
    currentTime = new Date(); // Real-time fixtures avoid unrelated TTL/expiry flakiness.
    const id = new Types.ObjectId();
    actor = {
      adminAccountId: id.toHexString(),
      publicId: 'adm_23456789ABCD',
      id: 'adm_23456789ABCD',
      username: 'sponsored.fixture',
      displayName: 'Sponsored Fixture',
      role: AdminRole.SUPER_ADMIN,
      sessionId: 'ases_23456789ABCDEFGH',
      credentialVersion: 0,
      authzVersion: 0,
      permissionVersion: 1,
    };
    await accounts.collection.insertOne({
      _id: id,
      publicId: actor.publicId,
      username: actor.username,
      displayName: actor.displayName,
      role: actor.role,
      status: 'ACTIVE',
      mfaStatus: 'ACTIVE',
      mustChangePassword: false,
      deletedAt: null,
      credentialVersion: 0,
      authzVersion: 0,
      permissionVersion: 1,
    } as never);
    await sessions.collection.insertOne({
      adminAccountId: id,
      adminPublicId: actor.publicId,
      publicId: actor.sessionId,
      revokedAt: null,
      expiresAt: new Date(currentTime.getTime() + 10 * DAY),
    } as never);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (connection && Number(connection.readyState) === 1) {
        if (
          connection.name !== databaseName ||
          !/^betta_spon_mut_it_\d+_[a-f0-9]{12}$/.test(connection.name)
        ) {
          throw new Error('Refusing to clean a non-fixture database');
        }
        await connection.dropDatabase();
      }
    } finally {
      if (moduleRef) await moduleRef.close();
      if (connection) await connection.close();
    }
  });

  const payload = () => {
    const value = draft();
    return {
      content: value.content,
      cta: value.cta,
      destinationUrl: value.destinationUrl,
      startAt: value.startAt.toISOString(),
      endAt: value.endAt.toISOString(),
      reasonCode: context.reasonCode,
    };
  };
  const apiCreate = (key: string = randomUUID()) =>
    mutations.execute(actor, 'create', null, payload(), key);

  it('persists safe changed fields and dates without raw text or URL in audit', async () => {
    const original = payload();
    const post = await apiCreate();
    const input = {
      ...original,
      expectedVersion: 0,
      content: 'Private synthetic campaign text',
      cta: 'Private synthetic CTA',
      destinationUrl: 'https://example.com/offer?token=synthetic_secret',
      startAt: new Date(currentTime.getTime() + DAY).toISOString(),
      endAt: new Date(currentTime.getTime() + 3 * DAY).toISOString(),
      correlationId: 'corr_spon_safe_diff_0001',
    };
    await mutations.execute(
      actor,
      'update',
      post.publicId,
      input,
      randomUUID(),
    );
    const page = await audit.list({
      page: 1,
      limit: 20,
      action: AdminAuditAction.SPONSORED_UPDATED,
      targetPublicId: post.publicId,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].correlationId).toBe(input.correlationId);
    expect(page.items[0].metadata).toMatchObject({
      sponsoredChangedFields: [
        'content',
        'cta',
        'destinationUrl',
        'startAt',
        'endAt',
      ],
      sponsoredBeforeStartAt: original.startAt,
      sponsoredAfterStartAt: input.startAt,
      sponsoredBeforeEndAt: original.endAt,
      sponsoredAfterEndAt: input.endAt,
    });
    const stored = JSON.stringify(await audits.find({}).lean());
    for (const secret of [
      input.content,
      input.cta,
      input.destinationUrl,
      'synthetic_secret',
    ])
      expect(stored).not.toContain(secret);
    await mutations.execute(
      actor,
      'update',
      post.publicId,
      { ...input, expectedVersion: 1 },
      randomUUID(),
    );
    const noop = await audits
      .findOne({
        action: AdminAuditAction.SPONSORED_UPDATED,
        'metadata.afterVersion': 2,
      })
      .lean();
    expect(noop?.metadata?.sponsoredChangedFields).toEqual([]);
    expect(noop?.metadata?.sponsoredBeforeStartAt).toBeUndefined();
  });

  it('excludes correlation from replay identity and preserves the original audit', async () => {
    const key = randomUUID();
    const input = {
      ...payload(),
      correlationId: 'corr_spon_first_request_0001',
    };
    const first = await mutations.execute(actor, 'create', null, input, key);
    expect(
      await mutations.execute(
        actor,
        'create',
        null,
        { ...input, correlationId: 'corr_spon_replay_request_0002' },
        key,
      ),
    ).toEqual(first);
    expect(await audits.countDocuments({})).toBe(1);
    expect((await audits.findOne({}).lean())?.correlationId).toBe(
      input.correlationId,
    );
    const correlationId = 'corr_spon_delete_request_0003';
    await mutations.execute(
      actor,
      'delete',
      first.publicId,
      { expectedVersion: 0, reasonCode: input.reasonCode, correlationId },
      randomUUID(),
    );
    expect(
      await connection!
        .collection('outbox_events')
        .countDocuments({ correlationId }),
    ).toBe(1);
  });

  it.each([
    { sponsoredChangedFields: ['contactEmail'] },
    { sponsoredChangedFields: ['content', 'content'] },
    {
      sponsoredChangedFields: ['startAt'],
      sponsoredAfterStartAt: 'https://example.com/private',
    },
    { sponsoredChangedFields: ['content'], rawContent: 'must_not_persist' },
  ])(
    'fails closed and rolls back unsafe audit metadata %j',
    async (metadata) => {
      const record = audit.record.bind(audit) as AdminAuditService['record'];
      jest
        .spyOn(audit, 'record')
        .mockImplementation((input) =>
          record({ ...input, metadata: metadata as never }),
        );
      await expect(apiCreate()).rejects.toThrow();
      expect(await posts.countDocuments({})).toBe(0);
      expect(await audits.countDocuments({})).toBe(0);
      expect(await receipts.countDocuments({})).toBe(0);
    },
  );

  it('generates correlation when absent and rejects invalid correlation before writing', async () => {
    await expect(
      mutations.execute(
        actor,
        'create',
        null,
        { ...payload(), correlationId: 'bad' },
        randomUUID(),
      ),
    ).rejects.toThrow('SPONSORED_CORRELATION_ID_INVALID');
    expect(await posts.countDocuments({})).toBe(0);
    await apiCreate();
    expect((await audits.findOne({}).lean())?.correlationId).toMatch(
      /^corr_[a-f0-9-]{36}$/,
    );
  });

  it('creates one draft and one audit for simultaneous duplicate submits', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([apiCreate(key), apiCreate(key)]);
    expect(a).toEqual(b);
    expect(await posts.countDocuments({})).toBe(1);
    expect(await receipts.countDocuments({})).toBe(1);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.SPONSORED_CREATED,
      }),
    ).toBe(1);
  });
  it('rejects key reuse with a different payload and rejects revoked-session replay', async () => {
    const key = randomUUID();
    await apiCreate(key);
    await expect(
      mutations.execute(
        actor,
        'create',
        null,
        { ...payload(), content: 'Different' },
        key,
      ),
    ).rejects.toThrow('SPONSORED_IDEMPOTENCY_KEY_REUSED');
    await sessions.collection.updateOne(
      { publicId: actor.sessionId },
      { $set: { revokedAt: new Date() } },
    );
    await expect(apiCreate(key)).rejects.toThrow(
      'SPONSORED_ADMIN_SESSION_INVALID',
    );
    expect(await posts.countDocuments({})).toBe(1);
  });
  it('rejects ordinary Admin, missing key and unsafe URL without writes', async () => {
    await expect(
      mutations.execute(
        { ...actor, role: AdminRole.ADMIN },
        'create',
        null,
        payload(),
        randomUUID(),
      ),
    ).rejects.toThrow('SPONSORED_SUPER_ADMIN_REQUIRED');
    await expect(apiCreate('')).rejects.toThrow(
      'SPONSORED_IDEMPOTENCY_KEY_INVALID',
    );
    await expect(
      mutations.execute(
        actor,
        'create',
        null,
        { ...payload(), destinationUrl: 'http://127.0.0.1' },
        randomUUID(),
      ),
    ).rejects.toThrow('SPONSORED_INPUT_INVALID');
    expect(await receipts.countDocuments({})).toBe(0);
    expect(await posts.countDocuments({})).toBe(0);
  });
  it('rolls back campaign and reservation on mandatory audit failure', async () => {
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    const key = randomUUID();
    await expect(apiCreate(key)).rejects.toThrow('AUDIT_UNAVAILABLE');
    expect(await posts.countDocuments({})).toBe(0);
    expect(await receipts.countDocuments({})).toBe(0);
    await expect(apiCreate(key)).resolves.toMatchObject({
      status: Status.DRAFT,
    });
  });
  it('updates with CAS, replays once and refuses stale version', async () => {
    const post = await apiCreate();
    const key = randomUUID();
    const input = { ...payload(), content: 'Updated', expectedVersion: 0 };
    const a = await mutations.execute(
      actor,
      'update',
      post.publicId,
      input,
      key,
    );
    expect(a.version).toBe(1);
    expect(a.content).toBe('Updated');
    expect(
      await mutations.execute(actor, 'update', post.publicId, input, key),
    ).toEqual(a);
    await expect(
      mutations.execute(actor, 'update', post.publicId, input, randomUUID()),
    ).rejects.toThrow('SPONSORED_VERSION_CONFLICT');
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.SPONSORED_UPDATED,
      }),
    ).toBe(1);
  });
  it('has one winner for simultaneous different-key updates', async () => {
    const post = await apiCreate();
    const input = { ...payload(), expectedVersion: 0 };
    const results = await Promise.allSettled([
      mutations.execute(
        actor,
        'update',
        post.publicId,
        { ...input, content: 'A' },
        randomUUID(),
      ),
      mutations.execute(
        actor,
        'update',
        post.publicId,
        { ...input, content: 'B' },
        randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await posts.findOne({ publicId: post.publicId }))?.version).toBe(1);
  });
  it('requires pause before editing active content', async () => {
    const post = await create();
    await healthy(post.publicId);
    await move(post.publicId, 0, Action.SCHEDULE);
    await move(post.publicId, 1, Action.ACTIVATE);
    await expect(
      mutations.execute(
        actor,
        'update',
        post.publicId,
        { ...payload(), expectedVersion: 2 },
        randomUUID(),
      ),
    ).rejects.toThrow('SPONSORED_EDIT_REQUIRES_DRAFT_OR_PAUSED');
    await move(post.publicId, 2, Action.PAUSE);
    await expect(
      mutations.execute(
        actor,
        'update',
        post.publicId,
        { ...payload(), expectedVersion: 3 },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: Status.PAUSED, version: 4 });
  });
  it('soft deletes once, queues cleanup once and restores only to draft/unknown health', async () => {
    const post = await apiCreate();
    const input = { expectedVersion: 0, reasonCode: context.reasonCode };
    const key = randomUUID();
    const deleted = await mutations.execute(
      actor,
      'delete',
      post.publicId,
      input,
      key,
    );
    expect(deleted.status).toBe(Status.DELETED);
    expect(
      await mutations.execute(actor, 'delete', post.publicId, input, key),
    ).toEqual(deleted);
    expect(await posts.countDocuments({ publicId: post.publicId })).toBe(1);
    expect(
      await connection!.collection('outbox_events').countDocuments({
        eventType: 'sponsored.media.cleanup',
        aggregatePublicId: post.publicId,
      }),
    ).toBe(1);
    const restored = await mutations.execute(
      actor,
      'restore',
      post.publicId,
      { expectedVersion: 1, reasonCode: context.reasonCode },
      randomUUID(),
    );
    expect(restored).toMatchObject({
      status: Status.DRAFT,
      version: 2,
      deletedAt: null,
    });
    expect(
      (await posts.findOne({ publicId: post.publicId }).select('+assetHealth'))
        ?.assetHealth,
    ).toBe(Health.UNKNOWN);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.SPONSORED_DELETED,
      }),
    ).toBe(1);
  });
  it.each(['update', 'delete', 'restore'] as const)(
    'rolls back %s on audit failure',
    async (operation) => {
      const post = await apiCreate();
      if (operation === 'restore') {
        await mutations.execute(
          actor,
          'delete',
          post.publicId,
          { expectedVersion: 0, reasonCode: context.reasonCode },
          randomUUID(),
        );
      }
      const before = await posts.findOne({ publicId: post.publicId }).lean();
      const count = await receipts.countDocuments({});
      const outboxCount = await connection!
        .collection('outbox_events')
        .countDocuments({});
      jest
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
      const input =
        operation === 'update'
          ? { ...payload(), expectedVersion: 0, content: 'Must rollback' }
          : {
              expectedVersion: operation === 'restore' ? 1 : 0,
              reasonCode: context.reasonCode,
            };
      await expect(
        mutations.execute(actor, operation, post.publicId, input, randomUUID()),
      ).rejects.toThrow('AUDIT_UNAVAILABLE');
      expect(await posts.findOne({ publicId: post.publicId }).lean()).toEqual(
        before,
      );
      expect(await receipts.countDocuments({})).toBe(count);
      expect(
        await connection!.collection('outbox_events').countDocuments({}),
      ).toBe(outboxCount);
    },
  );
  it('does not restore a campaign whose schedule has ended', async () => {
    const post = await apiCreate();
    await mutations.execute(
      actor,
      'delete',
      post.publicId,
      { expectedVersion: 0, reasonCode: context.reasonCode },
      randomUUID(),
    );
    currentTime = new Date(currentTime.getTime() + 3 * DAY);
    await expect(
      mutations.execute(
        actor,
        'restore',
        post.publicId,
        { expectedVersion: 1, reasonCode: context.reasonCode },
        randomUUID(),
      ),
    ).rejects.toThrow('SPONSORED_SCHEDULE_ENDED');
    expect((await posts.findOne({ publicId: post.publicId }))?.status).toBe(
      Status.DELETED,
    );
  });
});
