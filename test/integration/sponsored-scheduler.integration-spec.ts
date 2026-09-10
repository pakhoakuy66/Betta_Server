import { ConfigService } from '@nestjs/config';
import { SponsoredActivationService } from '../../src/modules/sponsored-posts/sponsored-activation.service';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { createConnection, Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { SponsoredPostsModule } from '../../src/modules/sponsored-posts/sponsored-posts.module';
import { SponsoredPost } from '../../src/modules/sponsored-posts/sponsored-post.schema';
import {
  SponsoredSchedulerStore,
  SponsoredLeaseLost,
} from '../../src/modules/sponsored-posts/sponsored-scheduler.store';
import { SponsoredSchedulerService } from '../../src/modules/sponsored-posts/sponsored-scheduler.service';
import { SponsoredLifecycleService } from '../../src/modules/sponsored-posts/sponsored-lifecycle.service';
import { SponsoredMediaCloudService } from '../../src/modules/sponsored-posts/sponsored-media-cloud.service';
import { SponsoredPostWriterService } from '../../src/modules/sponsored-posts/sponsored-post-writer.service';
import {
  SPONSORED_CLOCK,
  generateSponsoredPublicId,
  SponsoredTransition as Action,
} from '../../src/modules/sponsored-posts/sponsored-post.constants';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import type { AdminRequestPrincipal } from '../../src/modules/admin/types/admin-authenticated-request';

@Module({})
class FixtureConnection {}
// 12 ASCII prefix bytes + 24 random hex chars = 36 bytes (server limit: 38).
const databaseName = `betta_ss_it_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const DAY = 86400000;
jest.setTimeout(120000);
describe('SADM-SPON-03 scheduler MongoDB transactions', () => {
  let connection: Connection;
  let moduleRef: TestingModule;
  let posts: Model<SponsoredPost>;
  let audits: Model<AdminAuditEvent>;
  let store: SponsoredSchedulerStore;
  let worker: SponsoredSchedulerService;
  let lifecycle: SponsoredLifecycleService;
  let audit: AdminAuditService;
  let actor: AdminRequestPrincipal;
  let now: Date;
  let appTime: Date;
  const cloud = {
    health: jest.fn<() => Promise<string>>().mockResolvedValue('healthy'),
  };
  beforeAll(async () => {
    if (
      Buffer.byteLength(databaseName, 'utf8') > 38 ||
      !/^betta_ss_it_[a-f0-9]{24}$/.test(databaseName)
    )
      throw new Error('SPONSORED_TEST_DATABASE_NAME_INVALID');
    const uri = process.env.MONGODB_INTEGRATION_URI?.trim();
    if (
      !uri ||
      process.env.RUN_MONGODB_INTEGRATION_TESTS !== 'YES' ||
      [process.env.DATABASE_URL, process.env.MONGODB_URI].some(
        (x) => x?.trim() === uri,
      )
    )
      throw new Error('Dedicated integration URI and YES required');
    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15000,
    }).asPromise();
    moduleRef = await Test.createTestingModule({
      imports: [
        {
          module: FixtureConnection,
          global: true,
          providers: [{ provide: getConnectionToken(), useValue: connection }],
          exports: [getConnectionToken()],
        },
        SponsoredPostsModule,
      ],
    })
      .overrideProvider(SponsoredMediaCloudService)
      .useValue(cloud)
      .overrideProvider(SPONSORED_CLOCK)
      .useValue(() => appTime)
      .compile();
    posts = moduleRef.get(getModelToken(SponsoredPost.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    store = moduleRef.get(SponsoredSchedulerStore);
    worker = moduleRef.get(SponsoredSchedulerService);
    lifecycle = moduleRef.get(SponsoredLifecycleService);
    audit = moduleRef.get(AdminAuditService);
    await posts.createIndexes();
    await audits.createIndexes();
    await store.ensureIndexes();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    cloud.health.mockReset().mockResolvedValue('healthy');
    await posts.collection.deleteMany({});
    await audits.collection.deleteMany({});
    await store.jobs.deleteMany({});
    await store.control.deleteMany({});
    await store.initialize();
    now = await store.now();
    appTime = now;
    const accounts = moduleRef.get<Model<AdminAccount>>(
      getModelToken(AdminAccount.name),
    );
    const sessions = moduleRef.get<Model<AdminSession>>(
      getModelToken(AdminSession.name),
    );
    await accounts.collection.deleteMany({});
    await sessions.collection.deleteMany({});
    const id = new Types.ObjectId();
    actor = {
      adminAccountId: id.toHexString(),
      id: 'adm_23456789ABCD',
      publicId: 'adm_23456789ABCD',
      username: 'scheduler.fixture',
      displayName: 'Scheduler fixture',
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
      expiresAt: new Date(now.getTime() + 10 * DAY),
    } as never);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (
        connection &&
        Number(connection.readyState) === 1 &&
        connection.name === databaseName &&
        /^betta_ss_it_[a-f0-9]{24}$/.test(databaseName)
      )
        await connection.dropDatabase();
    } finally {
      if (moduleRef) await moduleRef.close();
      if (connection) await connection.close();
    }
  });
  // Raw lifecycle records below are synthetic fixtures in the disposable test DB only.
  const fixture = async (status = 'scheduled', start = -DAY, end = DAY) => {
    const publicId = generateSponsoredPublicId();
    await posts.collection.insertOne({
      publicId,
      ownerPublicId: actor.publicId,
      content: 'Synthetic',
      images: [],
      cta: 'Learn more',
      destinationUrl: 'https://example.com/offer',
      status,
      startAt: new Date(now.getTime() + start),
      endAt: new Date(now.getTime() + end),
      deletedAt: null,
      version: 0,
      assetHealth: 'unknown',
      createdAt: now,
      updatedAt: now,
    } as never);
    return publicId;
  };
  const read = (publicId: string) => posts.collection.findOne({ publicId });
  const command = (publicId: string, expectedVersion: number, action: Action) =>
    lifecycle.execute(actor, publicId, action, {
      expectedVersion,
      reasonCode: 'campaign_review',
      correlationId: 'corr_scheduler_manual_0001',
    });
  it('activates once despite concurrent instances and repeated ticks', async () => {
    const id = await fixture();
    const other = new SponsoredSchedulerService(
      connection,
      posts,
      store,
      moduleRef.get(SponsoredPostWriterService),
      moduleRef.get(SponsoredActivationService),
      moduleRef.get(ConfigService),
    );
    await Promise.all([worker.tick(), other.tick()]);
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'active', version: 1 });
    expect(await audits.countDocuments({ action: 'sponsored.activated' })).toBe(
      1,
    );
  });
  it('ignores application clock skew and does not activate before start', async () => {
    const id = await fixture('scheduled', DAY, 3 * DAY);
    appTime = new Date(now.getTime() + 100 * DAY);
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'scheduled', version: 0 });
  });
  it('atomically expires a missed window without publishing and audits both legal transitions', async () => {
    const id = await fixture('scheduled', -3 * DAY, -DAY);
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'expired', version: 2 });
    expect(await audits.countDocuments({ action: 'sponsored.activated' })).toBe(
      0,
    );
    expect(await audits.countDocuments({ action: 'sponsored.paused' })).toBe(1);
    expect(await audits.countDocuments({ action: 'sponsored.expired' })).toBe(
      1,
    );
  });
  it('rolls back transitions and completion when mandatory audit fails, then retries once', async () => {
    const id = await fixture();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValue(new Error('synthetic audit failure'));
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'scheduled', version: 0 });
    expect(await store.jobs.findOne({ publicId: id })).toMatchObject({
      state: 'pending',
      attempts: 1,
    });
    jest.restoreAllMocks();
    await store.jobs.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'active', version: 1 });
    expect(await audits.countDocuments({ action: 'sponsored.activated' })).toBe(
      1,
    );
  });
  it('rejects stale lease owners and recovers after a crashed owner expires', async () => {
    const first = await store.acquire();
    expect(first).not.toBeNull();
    expect(await store.acquire()).toBeNull();
    await store.control.updateOne(
      { _id: 'lifecycle' },
      { $set: { leaseUntil: new Date(0) } },
    );
    const second = await store.acquire();
    expect(second).not.toBeNull();
    await expect(
      connection.transaction((session) => store.fence(first!.token, session)),
    ).rejects.toBeInstanceOf(SponsoredLeaseLost);
    await store.release(first!.token); // Must not release a successor's lease.
    expect(await store.acquire()).toBeNull();
    await store.release(second!.token);
    const id = await fixture();
    await worker.tick();
    expect((await read(id))?.status).toBe('active');
  });
  it('backs off repeated failures and preserves manual-review jobs without TTL', async () => {
    const id = await fixture();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValue(new Error('synthetic outage'));
    for (let attempt = 1; attempt <= 5; attempt++) {
      await worker.tick();
      const job = await store.jobs.findOne({ publicId: id });
      expect(job?.attempts).toBe(attempt);
      expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
      if (attempt < 5)
        await store.jobs.updateMany(
          {},
          { $set: { nextAttemptAt: new Date(0) } },
        );
    }
    const job = await store.jobs.findOne({ publicId: id });
    expect(job?.state).toBe('manual_review');
    expect(job).not.toHaveProperty('expiresAt');
    expect((await read(id))?.version).toBe(0);
  });
  it('drains bounded discovery batches while older records require manual review', async () => {
    const blocked = await fixture();
    await posts.collection.updateOne(
      { publicId: blocked },
      { $set: { assetHealth: 'missing' } },
    );
    for (let i = 0; i < 27; i++) await fixture();
    for (let i = 0; i < 4; i++) await worker.tick();
    expect(await posts.countDocuments({ status: 'active' })).toBe(27);
    expect(await store.jobs.findOne({ publicId: blocked })).toMatchObject({
      state: 'manual_review',
    });
  });
  it('allows manual lifecycle via live principal, CAS, and fresh health proof', async () => {
    const id = await fixture('draft');
    const scheduled = await command(id, 0, Action.SCHEDULE);
    expect(scheduled.version).toBe(1);
    const active = await command(id, 1, Action.ACTIVATE);
    expect(active.status).toBe('active');
    await expect(command(id, 1, Action.PAUSE)).rejects.toThrow(
      'SPONSORED_VERSION_CONFLICT',
    );
    await command(id, 2, Action.PAUSE);
    await command(id, 3, Action.RESUME);
    expect(await read(id)).toMatchObject({ status: 'active', version: 4 });
  });
  it('rejects unprivileged and revoked principals and reupload-required activation', async () => {
    const id = await fixture('draft');
    const saved = actor;
    actor = { ...actor, role: AdminRole.ADMIN };
    await expect(command(id, 0, Action.SCHEDULE)).rejects.toThrow(
      'SPONSORED_SUPER_ADMIN_REQUIRED',
    );
    actor = saved;
    await posts.collection.updateOne(
      { publicId: id },
      { $set: { assetHealth: 'corrupt' } },
    );
    await expect(command(id, 0, Action.SCHEDULE)).rejects.toThrow(
      'SPONSORED_REUPLOAD_REQUIRED',
    );
    await moduleRef
      .get<Model<AdminSession>>(getModelToken(AdminSession.name))
      .collection.updateMany({}, { $set: { revokedAt: now } });
    await expect(command(id, 0, Action.RETURN_TO_DRAFT)).rejects.toThrow(
      'SPONSORED_ADMIN_SESSION_INVALID',
    );
    expect((await read(id))?.version).toBe(0);
  });
  it('honors exact start/end boundaries using a controlled lifecycle clock', async () => {
    const id = await fixture('scheduled', DAY, 3 * DAY);
    const clock = jest
      .spyOn(store, 'now')
      .mockResolvedValue(new Date(now.getTime() + DAY - 1));
    await expect(command(id, 0, Action.ACTIVATE)).rejects.toThrow(
      'SPONSORED_NOT_ELIGIBLE',
    );
    clock.mockResolvedValue(new Date(now.getTime() + DAY));
    await command(id, 0, Action.ACTIVATE);
    await command(id, 1, Action.PAUSE);
    clock.mockResolvedValue(new Date(now.getTime() + 3 * DAY));
    await expect(command(id, 2, Action.RESUME)).rejects.toThrow(
      'SPONSORED_NOT_ELIGIBLE',
    );
    expect(await read(id)).toMatchObject({ status: 'paused', version: 2 });
  });
  it('does not overwrite a manual pause committed during the external probe', async () => {
    const id = await fixture();
    await posts.collection.updateOne(
      { publicId: id },
      {
        $set: {
          images: [
            {
              publicId:
                'betta/staging/sponsored/sma_23456789abcdef0123456789abcdef01',
              url: 'https://res.cloudinary.com/fixture/image/upload/asset.webp',
            },
          ],
        },
      },
    );
    cloud.health.mockImplementationOnce(async () => {
      await command(id, 0, Action.PAUSE);
      return 'healthy';
    });
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'paused', version: 1 });
    expect(await audits.countDocuments({ action: 'sponsored.activated' })).toBe(
      0,
    );
  });
  it('expires Active and Paused at the end without a physical delete', async () => {
    const a = await fixture('active', -2 * DAY, 0);
    const b = await fixture('paused', -2 * DAY, 0);
    await worker.tick();
    for (const id of [a, b])
      expect(await read(id)).toMatchObject({
        status: 'expired',
        version: 1,
        deletedAt: null,
      });
  });
  it('cannot activate an asset retired from the attached registry even if Cloudinary says healthy', async () => {
    const id = await fixture();
    await posts.collection.updateOne(
      { publicId: id },
      {
        $set: {
          images: [
            {
              publicId:
                'betta/staging/sponsored/sma_23456789abcdef0123456789abcdef01',
              url: 'https://res.cloudinary.com/fixture/image/upload/asset.webp',
            },
          ],
        },
      },
    );
    await worker.tick();
    expect(cloud.health).toHaveBeenCalledTimes(1);
    expect(await read(id)).toMatchObject({ status: 'scheduled', version: 0 });
    expect(await store.jobs.findOne({ publicId: id })).toMatchObject({
      state: 'manual_review',
    });
  });
  it('expires a campaign even when its earlier activation job requires manual review', async () => {
    const id = await fixture();
    await posts.collection.updateOne(
      { publicId: id },
      { $set: { assetHealth: 'missing' } },
    );
    await worker.tick();
    expect(
      await store.jobs.findOne({ publicId: id, kind: 'activate' }),
    ).toMatchObject({ state: 'manual_review' });
    // Simulate elapsed wall time, preserving version to test phase-specific dedupe.
    await posts.collection.updateOne(
      { publicId: id },
      {
        $set: {
          startAt: new Date(now.getTime() - 3 * DAY),
          endAt: new Date(now.getTime() - DAY),
        },
      },
    );
    await worker.tick();
    expect(await read(id)).toMatchObject({ status: 'expired', version: 2 });
    expect(
      await store.jobs.findOne({ publicId: id, kind: 'expire' }),
    ).toMatchObject({ state: 'done' });
  });
  it('uses indexed due scans and has no campaign TTL', async () => {
    await fixture();
    const plan = await posts
      .find({ status: 'scheduled', startAt: { $lte: now } })
      .sort({ startAt: 1, publicId: 1 })
      .hint('sponsored_status_start_public_id')
      .explain('executionStats');
    expect(JSON.stringify(plan)).toContain('IXSCAN');
    expect(JSON.stringify(plan)).not.toContain('COLLSCAN');
    const jobPlan = await store.jobs
      .find({ state: 'pending', nextAttemptAt: { $lte: now } })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .hint('sponsored_jobs_due')
      .explain('executionStats');
    expect(JSON.stringify(jobPlan)).not.toContain('COLLSCAN');
    expect(
      (await posts.collection.indexes()).some(
        (x) => x.expireAfterSeconds !== undefined,
      ),
    ).toBe(false);
  });
});
