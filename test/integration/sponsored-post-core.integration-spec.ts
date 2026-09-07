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
  SPONSORED_INDEXES,
  SponsoredAssetHealth as Health,
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from '../../src/modules/sponsored-posts/sponsored-post.constants';
import { SponsoredPost } from '../../src/modules/sponsored-posts/sponsored-post.schema';
import { SponsoredPostWriterService } from '../../src/modules/sponsored-posts/sponsored-post-writer.service';
import { SponsoredPostsModule } from '../../src/modules/sponsored-posts/sponsored-posts.module';

const databaseName = `betta_spon_core_it_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const context = {
  reasonCode: 'campaign_review',
  correlationId: 'corr_spon_core_integration_0001',
};
jest.setTimeout(120_000);
@Module({})
class FixtureConnectionModule {}

describe('SADM-SPON-01 SponsoredPost core MongoDB integration', () => {
  let moduleRef: TestingModule | undefined;
  let connection: Connection | undefined;
  let posts: Model<SponsoredPost>;
  let audits: Model<AdminAuditEvent>;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let writer: SponsoredPostWriterService;
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
    for (const model of [posts, audits, accounts, sessions])
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
          !/^betta_spon_core_it_\d+_[a-f0-9]{12}$/.test(connection.name)
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

  it('compiles the actual module and persists a separate draft with one safe audit', async () => {
    const result = await create();
    expect(result.status).toBe(Status.DRAFT);
    expect(result.version).toBe(0);
    expect(result.publicId).toMatch(/^spn_/);
    const stored = await posts.collection.findOne({
      publicId: result.publicId,
    });
    expect(stored?.ownerPublicId).toBe(actor.publicId);
    expect(stored?.assetHealth).toBe(Health.UNKNOWN);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.SPONSORED_CREATED,
      }),
    ).toBe(1);
    const names = (await connection!.db!.listCollections().toArray()).map(
      (item) => item.name,
    );
    expect(names).not.toContain('posts');
    expect(names).not.toContain('users');
    expect(JSON.stringify(result)).not.toContain(actor.publicId);
    expect(stored).not.toHaveProperty('expireAt');
  });

  it('defines unique and lifecycle indexes without any SponsoredPost TTL', async () => {
    const indexes = (await posts.collection
      .listIndexes()
      .toArray()) as unknown as { name: string; expireAfterSeconds?: number }[];
    for (const name of Object.values(SPONSORED_INDEXES))
      expect(indexes.some((index) => index.name === name)).toBe(true);
    expect(
      indexes.every((index) => index.expireAfterSeconds === undefined),
    ).toBe(true);
    const result = await create();
    const record = await posts.collection.findOne({
      publicId: result.publicId,
    });
    await expect(
      posts.collection.insertOne({ ...record!, _id: new Types.ObjectId() }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects Admin and forged/stale SuperAdmin state before writing', async () => {
    await expect(
      writer.createDraft({ ...actor, role: AdminRole.ADMIN }, draft(), context),
    ).rejects.toMatchObject({ status: 403 });
    await accounts.collection.updateOne(
      { publicId: actor.publicId },
      { $set: { authzVersion: 1 } },
    );
    await expect(create()).rejects.toMatchObject({ status: 401 });
    expect(await posts.countDocuments()).toBe(0);
    expect(await audits.countDocuments()).toBe(0);
  });

  it('rejects revoked, foreign-owner and expired sessions', async () => {
    await sessions.collection.updateOne(
      { publicId: actor.sessionId },
      { $set: { revokedAt: currentTime } },
    );
    await expect(create()).rejects.toMatchObject({ status: 401 });
    await sessions.collection.updateOne(
      { publicId: actor.sessionId },
      { $set: { revokedAt: null, adminAccountId: new Types.ObjectId() } },
    );
    await expect(create()).rejects.toMatchObject({ status: 401 });
    await sessions.collection.updateOne(
      { publicId: actor.sessionId },
      {
        $set: {
          adminAccountId: new Types.ObjectId(actor.adminAccountId),
          expiresAt: new Date(currentTime),
        },
      },
    );
    await expect(create()).rejects.toMatchObject({ status: 401 });
    expect(await posts.countDocuments()).toBe(0);
    expect(await audits.countDocuments()).toBe(0);
  });

  it('rolls back draft creation if mandatory audit fails', async () => {
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('INJECTED_AUDIT_FAILURE'));
    await expect(create()).rejects.toThrow('INJECTED_AUDIT_FAILURE');
    expect(await posts.countDocuments()).toBe(0);
    expect(await audits.countDocuments()).toBe(0);
  });

  it('rolls back the transition and version if audit fails', async () => {
    const result = await create();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('INJECTED_AUDIT_FAILURE'));
    await expect(move(result.publicId, 0, Action.SCHEDULE)).rejects.toThrow(
      'INJECTED_AUDIT_FAILURE',
    );
    const record = await posts.findOne({ publicId: result.publicId });
    expect(record?.status).toBe(Status.DRAFT);
    expect(record?.version).toBe(0);
    expect(await audits.countDocuments()).toBe(1);
  });

  it('has one winner for concurrent transitions with the same expected version', async () => {
    const result = await create();
    const outcomes = await Promise.allSettled([
      move(result.publicId, 0, Action.SCHEDULE),
      move(result.publicId, 0, Action.DELETE),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect((await posts.findOne({ publicId: result.publicId }))?.version).toBe(
      1,
    );
    expect(await audits.countDocuments()).toBe(2);
  });

  it('does not activate before start, at end, or without healthy assets', async () => {
    const result = await create();
    await move(result.publicId, 0, Action.SCHEDULE);
    await expect(
      writer.transitionFromWorker(result.publicId, 1, Action.ACTIVATE),
    ).rejects.toMatchObject({ status: 409 });
    await healthy(result.publicId);
    currentTime = new Date(currentTime.getTime() - 1);
    await expect(
      writer.transitionFromWorker(result.publicId, 1, Action.ACTIVATE),
    ).rejects.toMatchObject({ status: 409 });
    currentTime = new Date(result.endAt);
    await expect(
      writer.transitionFromWorker(result.publicId, 1, Action.ACTIVATE),
    ).rejects.toMatchObject({ status: 409 });
    expect(await audits.countDocuments()).toBe(2);
  });

  it('transitions scheduled-active-paused-active-expired without touching organic data', async () => {
    const result = await create();
    await healthy(result.publicId);
    await move(result.publicId, 0, Action.SCHEDULE);
    expect(
      (await writer.transitionFromWorker(result.publicId, 1, Action.ACTIVATE))
        .status,
    ).toBe(Status.ACTIVE);
    await move(result.publicId, 2, Action.PAUSE);
    await move(result.publicId, 3, Action.RESUME);
    currentTime = new Date(result.endAt);
    expect(
      (await writer.transitionFromWorker(result.publicId, 4, Action.EXPIRE))
        .status,
    ).toBe(Status.EXPIRED);
    expect(await posts.countDocuments()).toBe(1);
    expect(await audits.countDocuments()).toBe(6);
    await expect(move(result.publicId, 5, Action.RESUME)).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('soft-deletes and restores only to Draft with health requiring revalidation', async () => {
    const result = await create();
    await healthy(result.publicId);
    await move(result.publicId, 0, Action.DELETE);
    const restored = await move(result.publicId, 1, Action.RESTORE);
    expect(restored.status).toBe(Status.DRAFT);
    expect(restored.deletedAt).toBeNull();
    expect(restored.endAt).toBe(result.endAt);
    const record = await posts.collection.findOne({
      publicId: result.publicId,
    });
    expect(record?.assetHealth).toBe(Health.UNKNOWN);
    expect(record?.ownerPublicId).toBe(actor.publicId);
    expect(await posts.countDocuments()).toBe(1);
  });

  it('enforces worker operation scope and confirms asset failure before machine pause', async () => {
    const result = await create();
    await move(result.publicId, 0, Action.SCHEDULE);
    await expect(
      writer.transitionFromWorker(result.publicId, 1, Action.PAUSE),
    ).rejects.toThrow('SPONSORED_ASSET_FAILURE_NOT_CONFIRMED');
    await posts.collection.updateOne(
      { publicId: result.publicId },
      { $set: { assetHealth: Health.MISSING } },
    );
    expect(
      (await writer.transitionFromWorker(result.publicId, 1, Action.PAUSE))
        .status,
    ).toBe(Status.PAUSED);
    const event = await audits.collection.findOne({
      action: AdminAuditAction.SPONSORED_PAUSED,
    });
    expect(event).toMatchObject({ actor: { type: 'system' } });
    expect(event?.reasonCode).toBe('asset_unavailable');
    await expect(
      writer.transitionFromWorker(result.publicId, 2, Action.DELETE as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('blocks model bypass updates and hard deletion', async () => {
    const result = await create();
    await expect(
      posts.updateOne(
        { publicId: result.publicId },
        { $set: { status: Status.ACTIVE } },
      ),
    ).rejects.toThrow('SPONSORED_AUDITED_WRITER_REQUIRED');
    await expect(
      posts.findOneAndDelete({ publicId: result.publicId }),
    ).rejects.toThrow('SPONSORED_AUDITED_WRITER_REQUIRED');
    await expect(
      posts.bulkWrite([
        { deleteOne: { filter: { publicId: result.publicId } } },
      ]),
    ).rejects.toThrow('SPONSORED_AUDITED_WRITER_REQUIRED');
    expect(await posts.countDocuments()).toBe(1);
  });
});
