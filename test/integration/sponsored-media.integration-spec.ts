import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { createConnection, type Connection, type Model, Types } from 'mongoose';
import sharp from 'sharp';
import {
  ADMIN_POLICY,
  createAdminPolicy,
} from '../../src/modules/admin/config/admin-policy.config';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import type { AdminRequestPrincipal } from '../../src/modules/admin/types/admin-authenticated-request';
import { SponsoredPostsModule } from '../../src/modules/sponsored-posts/sponsored-posts.module';
import { SponsoredPostWriterService } from '../../src/modules/sponsored-posts/sponsored-post-writer.service';
import { SponsoredPost } from '../../src/modules/sponsored-posts/sponsored-post.schema';
import { SponsoredMediaAsset } from '../../src/modules/sponsored-posts/sponsored-media-asset.schema';
import { SponsoredMediaService } from '../../src/modules/sponsored-posts/sponsored-media.service';
import { SponsoredMediaHealthService } from '../../src/modules/sponsored-posts/sponsored-media-health.service';
import { SponsoredMediaCloudService } from '../../src/modules/sponsored-posts/sponsored-media-cloud.service';
import { SponsoredTransition as Action } from '../../src/modules/sponsored-posts/sponsored-post.constants';
import { OutboxEvent } from '../../src/common/outbox/outbox-event.schema';

@Module({})
class FixtureConnectionModule {}
const dbName = `betta_spon_media_it_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
jest.setTimeout(120000);
describe('SADM-SPON-02 media transactions', () => {
  let connection: Connection;
  let moduleRef: TestingModule;
  let posts: Model<SponsoredPost>;
  let assets: Model<SponsoredMediaAsset>;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let audits: Model<AdminAuditEvent>;
  let outbox: Model<OutboxEvent>;
  let writer: SponsoredPostWriterService;
  let media: SponsoredMediaService;
  let health: SponsoredMediaHealthService;
  let audit: AdminAuditService;
  let actor: AdminRequestPrincipal;
  let file: { buffer: Buffer; size: number; mimetype: string };
  const cloud = {
    remoteId: (id: string) => `betta/test/sponsored/${id}`,
    upload: jest.fn<(id: string, bytes: Buffer) => Promise<string>>(),
    destroy: jest.fn<(id: string) => Promise<void>>(),
    health:
      jest.fn<(id: string) => Promise<'healthy' | 'missing' | 'corrupt'>>(),
  };
  const context = { reasonCode: 'campaign_review' };
  const create = () =>
    writer.createDraft(
      actor,
      {
        content: 'Synthetic media test',
        images: [],
        destinationUrl: 'https://example.com/offer',
        cta: 'Visit',
        startAt: new Date(),
        endAt: new Date(Date.now() + 2 * 86400000),
      },
      context,
    );
  beforeAll(async () => {
    const uri = process.env.MONGODB_INTEGRATION_URI;
    if (
      !uri ||
      process.env.RUN_MONGODB_INTEGRATION_TESTS !== 'YES' ||
      [process.env.DATABASE_URL, process.env.MONGODB_URI].includes(uri)
    )
      throw new Error('Dedicated integration configuration required');
    connection = await createConnection(uri, {
      dbName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    }).asPromise();
    moduleRef = await Test.createTestingModule({
      imports: [
        {
          module: FixtureConnectionModule,
          global: true,
          providers: [{ provide: getConnectionToken(), useValue: connection }],
          exports: [getConnectionToken()],
        },
        SponsoredPostsModule,
      ],
    })
      .overrideProvider(ADMIN_POLICY)
      .useValue(createAdminPolicy({ get: () => undefined }))
      .overrideProvider(SponsoredMediaCloudService)
      .useValue(cloud)
      .compile();
    posts = moduleRef.get(getModelToken(SponsoredPost.name));
    assets = moduleRef.get(getModelToken(SponsoredMediaAsset.name));
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    sessions = moduleRef.get(getModelToken(AdminSession.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outbox = moduleRef.get(getModelToken(OutboxEvent.name));
    for (const model of [posts, assets, accounts, sessions, audits, outbox])
      await model.createIndexes();
    writer = moduleRef.get(SponsoredPostWriterService);
    media = moduleRef.get(SponsoredMediaService);
    health = moduleRef.get(SponsoredMediaHealthService);
    audit = moduleRef.get(AdminAuditService);
    const buffer = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#abcdef' },
    })
      .png()
      .toBuffer();
    file = { buffer, size: buffer.length, mimetype: 'image/png' };
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    cloud.upload
      .mockReset()
      .mockImplementation((id) =>
        Promise.resolve(
          `https://res.cloudinary.com/fixture/image/upload/v1/${id}.webp`,
        ),
      );
    cloud.destroy.mockReset().mockResolvedValue(undefined);
    cloud.health.mockReset().mockResolvedValue('healthy');
    for (const model of [posts, assets, accounts, sessions, audits, outbox])
      await model.collection.deleteMany({});
    const id = new Types.ObjectId();
    actor = {
      adminAccountId: id.toHexString(),
      id: 'adm_23456789ABCD',
      publicId: 'adm_23456789ABCD',
      username: 'fixture',
      displayName: 'Fixture',
      role: AdminRole.SUPER_ADMIN,
      sessionId: 'ases_23456789ABCDEFGH',
      credentialVersion: 0,
      authzVersion: 0,
      permissionVersion: 1,
    };
    await accounts.collection.insertOne({
      _id: id,
      publicId: actor.publicId,
      username: 'fixture',
      displayName: 'Fixture',
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
      expiresAt: new Date(Date.now() + 86400000),
    } as never);
  });
  afterAll(async () => {
    try {
      if (
        connection &&
        connection.name === dbName &&
        /^betta_spon_media_it_[a-f0-9]{16}$/.test(dbName)
      ) {
        await connection.dropDatabase();
      }
    } finally {
      try {
        if (moduleRef) await moduleRef.close();
      } finally {
        if (connection) await connection.close();
      }
    }
  });
  it('uploads normalized images, commits health and audit with cleanup reservation', async () => {
    const post = await create();
    const result = await media.replace(actor, post.publicId, 0, [file]);
    expect(result.version).toBe(1);
    expect(await assets.countDocuments({ state: 'attached' })).toBe(1);
    expect(await outbox.countDocuments()).toBe(2);
    expect(await audits.countDocuments()).toBe(2);
    expect(
      (await posts.findOne({ publicId: post.publicId }).select('+assetHealth'))
        ?.assetHealth,
    ).toBe('healthy');
  });
  it('denies ordinary Admin before uploading', async () => {
    const post = await create();
    await expect(
      media.replace({ ...actor, role: AdminRole.ADMIN }, post.publicId, 0, [
        file,
      ]),
    ).rejects.toThrow();
    expect(cloud.upload).not.toHaveBeenCalled();
  });
  it('denies a revoked session before uploading', async () => {
    const post = await create();
    await sessions.collection.updateOne(
      { publicId: actor.sessionId },
      { $set: { revokedAt: new Date() } },
    );
    await expect(
      media.replace(actor, post.publicId, 0, [file]),
    ).rejects.toThrow('SPONSORED_ADMIN_SESSION_INVALID');
    expect(cloud.upload).not.toHaveBeenCalled();
  });
  it('rolls back media attachment on mandatory audit failure then cleans the orphan', async () => {
    const post = await create();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('Synthetic audit failure'));
    await expect(
      media.replace(actor, post.publicId, 0, [file]),
    ).rejects.toThrow('Synthetic audit failure');
    expect(
      (await posts.findOne({ publicId: post.publicId }))?.images,
    ).toHaveLength(0);
    expect(await assets.countDocuments({ state: 'ready' })).toBe(1);
    await assets.updateMany({}, { $set: { cleanupAfter: new Date(0) } });
    await media.cleanup(post.publicId);
    await media.cleanup(post.publicId);
    expect(cloud.destroy).toHaveBeenCalledTimes(1);
  });
  it('permits one concurrent replacement and never cleans winning images', async () => {
    const post = await create();
    const results = await Promise.allSettled([
      media.replace(actor, post.publicId, 0, [file]),
      media.replace(actor, post.publicId, 0, [file]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await assets.updateMany({}, { $set: { cleanupAfter: new Date(0) } });
    await media.cleanup(post.publicId);
    expect(await assets.countDocuments({ state: 'attached' })).toBe(1);
    const current = await posts.findOne({ publicId: post.publicId });
    expect(cloud.destroy.mock.calls.map((call) => call[0])).not.toContain(
      current?.images[0].publicId,
    );
  });
  it('keeps ambiguous uploads visible for manual review', async () => {
    const post = await create();
    cloud.upload.mockRejectedValueOnce(new Error('Synthetic timeout'));
    await expect(
      media.replace(actor, post.publicId, 0, [file]),
    ).rejects.toThrow();
    await assets.updateMany({}, { $set: { cleanupAfter: new Date(0) } });
    await expect(media.cleanup(post.publicId)).rejects.toThrow();
    expect(await assets.countDocuments({ state: 'manual_review' })).toBe(1);
    expect(cloud.destroy).not.toHaveBeenCalled();
  });
  it('cleans old images after replace and deleted campaign images idempotently', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    await media.replace(actor, post.publicId, 1, [file]);
    await media.cleanup(post.publicId);
    expect(cloud.destroy).toHaveBeenCalledTimes(1);
    await writer.transition(actor, post.publicId, 2, Action.DELETE, context);
    await media.cleanup(post.publicId);
    await media.cleanup(post.publicId);
    expect(cloud.destroy).toHaveBeenCalledTimes(2);
  });
  it('rejects media edits to active campaigns before upload', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    await writer.transition(actor, post.publicId, 1, Action.SCHEDULE, context);
    await writer.transition(actor, post.publicId, 2, Action.ACTIVATE, context);
    await expect(
      media.replace(actor, post.publicId, 3, [file]),
    ).rejects.toThrow('SPONSORED_PAUSE_BEFORE_MEDIA_EDIT');
    expect(cloud.upload).toHaveBeenCalledTimes(1);
  });
  it('pauses an active campaign when missing media is confirmed', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    await writer.transition(actor, post.publicId, 1, Action.SCHEDULE, context);
    await writer.transition(actor, post.publicId, 2, Action.ACTIVATE, context);
    cloud.health.mockResolvedValue('missing');
    await health.refresh(post.publicId);
    const stored = await posts
      .findOne({ publicId: post.publicId })
      .select('+assetHealth');
    expect(stored?.status).toBe('paused');
    expect(stored?.assetHealth).toBe('missing');
  });
  it('never publishes healthy for an asset already reserved for deletion', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    await assets.updateMany({}, { $set: { state: 'deleting' } });
    await health.refresh(post.publicId);
    expect(
      (await posts.findOne({ publicId: post.publicId }).select('+assetHealth'))
        ?.assetHealth,
    ).toBe('missing');
  });
  it('retries cleanup after a remote failure without reattaching retired assets', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    await writer.transition(actor, post.publicId, 1, Action.DELETE, context);
    cloud.destroy.mockRejectedValueOnce(new Error('Synthetic cleanup timeout'));
    await expect(media.cleanup(post.publicId)).rejects.toThrow();
    expect(await assets.countDocuments({ state: 'deleting' })).toBe(1);
    await media.cleanup(post.publicId);
    expect(await assets.countDocuments({ state: 'deleted' })).toBe(1);
  });
  it('drains multiple cleanup batches even when another asset needs manual review', async () => {
    const post = await create();
    const records = Array.from({ length: 102 }, (_, index) => {
      const publicId = `sma_${randomUUID().replace(/-/g, '')}`;
      return {
        publicId,
        campaignPublicId: post.publicId,
        remoteId: cloud.remoteId(publicId),
        state: index === 0 ? 'manual_review' : 'ready',
        cleanupAfter: new Date(0),
      };
    });
    await assets.insertMany(records);
    await expect(media.cleanup(post.publicId)).rejects.toMatchObject({
      code: 'SPONSORED_CLEANUP_HAS_MORE',
    });
    expect(await assets.countDocuments({ state: 'deleted' })).toBe(100);
    await expect(media.cleanup(post.publicId)).rejects.toMatchObject({
      code: 'SPONSORED_UPLOAD_MANUAL_REVIEW',
    });
    expect(await assets.countDocuments({ state: 'deleted' })).toBe(101);
    expect(await assets.countDocuments({ state: 'manual_review' })).toBe(1);
    expect(cloud.destroy).toHaveBeenCalledTimes(101);
  }, 600_000);
  it('does not misclassify infrastructure failure as a missing asset', async () => {
    const post = await create();
    await media.replace(actor, post.publicId, 0, [file]);
    cloud.health.mockRejectedValue(
      new Error('Synthetic infrastructure failure'),
    );
    await health.refresh(post.publicId);
    expect(
      (await posts.findOne({ publicId: post.publicId }).select('+assetHealth'))
        ?.assetHealth,
    ).toBe('unknown');
  });
});
