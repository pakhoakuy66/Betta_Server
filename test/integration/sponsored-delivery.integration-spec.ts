import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createConnection, type Connection, mongo } from 'mongoose';
import {
  SponsoredDeliveryStore,
  DELIVERY_COLLECTIONS as C,
} from '../../src/modules/sponsored-posts/sponsored-delivery.store';
import {
  SPONSORED_POST_COLLECTION,
  generateSponsoredPublicId,
} from '../../src/modules/sponsored-posts/sponsored-post.constants';
import { sessionDigest } from '../../src/modules/sponsored-posts/sponsored-delivery.policy';

const databaseName = `betta_sd_it_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
describe('SADM-SPON-04 delivery storage MongoDB integration', () => {
  let connection: Connection;
  let store: SponsoredDeliveryStore;
  let other: SponsoredDeliveryStore;
  const user = new mongo.ObjectId();
  const foreign = new mongo.ObjectId();
  const campaign = generateSponsoredPublicId();
  const secondCampaign = generateSponsoredPublicId();
  async function databaseNow(): Promise<number> {
    const response = await connection.db!.command({ hello: 1 });
    const time: unknown = response.localTime;
    if (!(time instanceof Date) || !Number.isFinite(time.getTime()))
      throw new Error('Integration MongoDB clock unavailable');
    return time.getTime();
  }
  beforeAll(async () => {
    const uri = process.env.MONGODB_INTEGRATION_URI?.trim();
    if (
      !uri ||
      process.env.RUN_MONGODB_INTEGRATION_TESTS !== 'YES' ||
      [process.env.DATABASE_URL, process.env.MONGODB_URI].some(
        (value) => value?.trim() === uri,
      )
    )
      throw new Error('Dedicated integration URI and explicit YES required');
    if (
      !/^betta_sd_it_[a-f0-9]{24}$/.test(databaseName) ||
      Buffer.byteLength(databaseName) > 38
    )
      throw new Error('Unsafe test database');
    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15000,
    }).asPromise();
    store = new SponsoredDeliveryStore(connection);
    other = new SponsoredDeliveryStore(connection);
    await store.prepareIndexes();
    const db = connection.db!;
    // Synthetic records ONLY in the disposable integration database.
    await db.collection('users').insertMany(
      [user, foreign].map((_id) => ({
        _id,
        status: 'active',
        isDeleted: false,
        deletedAt: null,
        restriction: null,
      })),
    );
    const now = await databaseNow();
    await db.collection(SPONSORED_POST_COLLECTION).insertMany(
      [campaign, secondCampaign].map((publicId) => ({
        publicId,
        status: 'active',
        deletedAt: null,
        assetHealth: 'healthy',
        startAt: new Date(now - 60000),
        endAt: new Date(now + 86400000),
      })),
    );
  }, 120000);
  afterAll(async () => {
    if (!connection) return;
    try {
      if (
        connection.name === databaseName &&
        /^betta_sd_it_[a-f0-9]{24}$/.test(databaseName)
      )
        await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  }, 30000);

  it('creates scoped opaque sessions and rejects foreign owners / limit changes', async () => {
    const issued = await store.open(user.toHexString(), 20);
    expect(
      await store.read(user.toHexString(), issued.feedSessionId, 1, 20),
    ).toBeNull();
    await expect(
      store.read(foreign.toHexString(), issued.feedSessionId, 1, 20),
    ).rejects.toThrow('SPONSORED_FEED_SESSION_NOT_FOUND');
    await expect(
      store.read(user.toHexString(), issued.feedSessionId, 1, 10),
    ).rejects.toThrow('SPONSORED_FEED_LIMIT_CHANGED');
    const stored = await connection
      .db!.collection<{ _id: string }>(C.sessions)
      .findOne({ _id: sessionDigest(issued.feedSessionId) });
    expect(JSON.stringify(stored)).not.toContain(issued.feedSessionId);
  });

  it('concurrent retries have one immutable page and receipt', async () => {
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    const results = await Promise.all(
      [store, other].map((service) =>
        service.commit(
          user.toHexString(),
          feedSessionId,
          1,
          20,
          ['post_A', 'post_B'],
          [campaign],
          true,
        ),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[0].campaignIds).toEqual([campaign]);
    const receipt = await connection
      .db!.collection(C.receipts)
      .findOne({ userId: user, campaignId: campaign });
    expect(Object.keys(receipt!).sort()).toEqual(
      [
        '_id',
        'userId',
        'campaignId',
        'feedSessionId',
        'deliveredAt',
        'expiresAt',
      ].sort(),
    );
    const retried = await store.commit(
      user.toHexString(),
      feedSessionId,
      1,
      20,
      ['post_DIFFERENT'],
      [secondCampaign],
      false,
    );
    expect(retried).toEqual(results[0]);
    expect(
      await connection
        .db!.collection(C.pages)
        .countDocuments({ feedSessionId: sessionDigest(feedSessionId) }),
    ).toBe(1);
    expect(
      await connection
        .db!.collection(C.receipts)
        .countDocuments({ userId: user, campaignId: campaign }),
    ).toBe(1);
    const page2 = await store.commit(
      user.toHexString(),
      feedSessionId,
      2,
      20,
      ['post_C'],
      [campaign],
      false,
    );
    expect(page2.campaignIds).toEqual([]);
    expect(page2.organicIds).toEqual(['post_C']);
  });

  it('cooldown remains across sessions, never forces a repeat when pool is empty', async () => {
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    const page = await store.commit(
      user.toHexString(),
      feedSessionId,
      1,
      20,
      ['post_D'],
      [campaign],
      false,
    );
    expect(page.campaignIds).toEqual([]);
    expect(page.organicIds).toEqual(['post_D']);
  });

  it('two sessions race for one user/campaign and exactly one receives it', async () => {
    const sessions = await Promise.all([
      store.open(user.toHexString(), 20),
      other.open(user.toHexString(), 20),
    ]);
    const result = await Promise.all(
      sessions.map((s, index) =>
        (index ? other : store).commit(
          user.toHexString(),
          s.feedSessionId,
          1,
          20,
          ['post_E'],
          [secondCampaign],
          false,
        ),
      ),
    );
    expect(result.flatMap((value) => value.campaignIds)).toEqual([
      secondCampaign,
    ]);
  });

  it('logical 24-hour expiry works before TTL deletes an expired receipt', async () => {
    const db = connection.db!;
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    // Test database only: retain the expired row to prove logical expiry, not
    // a lucky TTL deletion. Restore the production index policy in finally.
    if (
      connection.name !== databaseName ||
      !/^betta_sd_it_[a-f0-9]{24}$/.test(databaseName)
    )
      throw new Error('Unsafe TTL fixture database');
    await db.command({
      collMod: C.receipts,
      index: { name: 'sponsored_receipt_expiry', expireAfterSeconds: 3600 },
    });
    try {
      const changed = await db
        .collection(C.receipts)
        .updateOne({ userId: user, campaignId: campaign }, [
          {
            $set: {
              deliveredAt: { $subtract: ['$$NOW', 86400001] },
              expiresAt: { $subtract: ['$$NOW', 1] },
            },
          },
        ]);
      expect(changed.matchedCount).toBe(1);
      const expired = await db
        .collection(C.receipts)
        .findOne({ userId: user, campaignId: campaign });
      expect(expired).not.toBeNull();
      expect((expired!.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        await databaseNow(),
      );
      const result = await store.commit(
        user.toHexString(),
        feedSessionId,
        1,
        20,
        ['post_F'],
        [campaign],
        false,
      );
      expect(result.campaignIds).toEqual([campaign]);
      const receipt = await db
        .collection(C.receipts)
        .findOne({ userId: user, campaignId: campaign });
      expect(
        (receipt!.expiresAt as Date).getTime() -
          (receipt!.deliveredAt as Date).getTime(),
      ).toBe(86400000);
      expect(receipt!.feedSessionId).toBe(sessionDigest(feedSessionId));
    } finally {
      await db.command({
        collMod: C.receipts,
        index: { name: 'sponsored_receipt_expiry', expireAfterSeconds: 0 },
      });
    }
  });

  it('session expiry is enforced without waiting for TTL', async () => {
    const issued = await store.open(user.toHexString(), 20);
    await connection
      .db!.collection<{ _id: string; expiresAt: Date }>(C.sessions)
      .updateOne(
        { _id: sessionDigest(issued.feedSessionId) },
        { $set: { expiresAt: new Date(0) } },
      );
    await expect(
      store.read(user.toHexString(), issued.feedSessionId, 1, 20),
    ).rejects.toThrow('SPONSORED_FEED_SESSION_NOT_FOUND');
    await expect(
      store.commit(
        user.toHexString(),
        issued.feedSessionId,
        1,
        20,
        [],
        [],
        false,
      ),
    ).rejects.toThrow('SPONSORED_FEED_SESSION_NOT_FOUND');
  });

  it('rejects out of order pages without persisting a plan', async () => {
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    await expect(
      store.commit(user.toHexString(), feedSessionId, 2, 20, [], [], false),
    ).rejects.toThrow('SPONSORED_FEED_PAGE_OUT_OF_ORDER');
    expect(
      await connection
        .db!.collection(C.pages)
        .countDocuments({ feedSessionId: sessionDigest(feedSessionId) }),
    ).toBe(0);
  });

  it('skips missing/paused campaigns and never writes organic posts', async () => {
    const { feedSessionId } = await store.open(foreign.toHexString(), 20);
    await connection
      .db!.collection(SPONSORED_POST_COLLECTION)
      .updateOne({ publicId: campaign }, { $set: { status: 'paused' } });
    const result = await store.commit(
      foreign.toHexString(),
      feedSessionId,
      1,
      20,
      ['post_G'],
      [campaign, generateSponsoredPublicId()],
      false,
    );
    expect(result.campaignIds).toEqual([]);
    expect(result.organicIds).toEqual(['post_G']);
    expect(await connection.db!.collection('posts').countDocuments()).toBe(0);
  });

  it('has unique contention and TTL indexes; no analytics fields', async () => {
    const indexes = await connection.db!.collection(C.receipts).indexes();
    expect(
      indexes.find((index) => index.name === 'sponsored_user_campaign')?.unique,
    ).toBe(true);
    expect(
      indexes.find((index) => index.name === 'sponsored_receipt_expiry')
        ?.expireAfterSeconds,
    ).toBe(0);
    expect(
      await connection
        .db!.collection(C.receipts)
        .countDocuments({ fingerprint: { $exists: true } }),
    ).toBe(0);
  });

  it('rejects organic overlap across pages rather than silently dropping User Posts', async () => {
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    await store.commit(
      user.toHexString(),
      feedSessionId,
      1,
      20,
      ['post_H'],
      [],
      true,
    );
    await expect(
      store.commit(
        user.toHexString(),
        feedSessionId,
        2,
        20,
        ['post_H'],
        [],
        false,
      ),
    ).rejects.toThrow('SPONSORED_ORGANIC_PAGE_OVERLAP');
    expect(
      await store.read(user.toHexString(), feedSessionId, 2, 20),
    ).toBeNull();
  });

  it('rolls back receipts and session progress if checkpoint persistence fails', async () => {
    const db = connection.db!;
    const { feedSessionId } = await store.open(foreign.toHexString(), 20);
    await db.command({
      collMod: C.pages,
      validator: { page: { $lt: 0 } },
      validationLevel: 'strict',
    });
    try {
      await expect(
        store.commit(
          foreign.toHexString(),
          feedSessionId,
          1,
          20,
          ['post_I'],
          [secondCampaign],
          false,
        ),
      ).rejects.toThrow();
      expect(
        await db
          .collection(C.receipts)
          .countDocuments({ userId: foreign, campaignId: secondCampaign }),
      ).toBe(0);
      expect(
        await db
          .collection(C.pages)
          .countDocuments({ feedSessionId: sessionDigest(feedSessionId) }),
      ).toBe(0);
    } finally {
      await db.command({ collMod: C.pages, validator: {} });
    }
    const result = await store.commit(
      foreign.toHexString(),
      feedSessionId,
      1,
      20,
      ['post_I'],
      [secondCampaign],
      false,
    );
    expect(result.campaignIds).toEqual([secondCampaign]);
  });

  it.each(['missing', 'corrupt', 'unknown'])(
    'skips asset health %s',
    async (health) => {
      const id = generateSponsoredPublicId();
      const now = await databaseNow();
      await connection.db!.collection(SPONSORED_POST_COLLECTION).insertOne({
        publicId: id,
        status: 'active',
        deletedAt: null,
        assetHealth: health,
        startAt: new Date(0),
        endAt: new Date(now + 86400000),
      });
      const { feedSessionId } = await store.open(user.toHexString(), 20);
      expect(
        (
          await store.commit(
            user.toHexString(),
            feedSessionId,
            1,
            20,
            ['post_J'],
            [id],
            false,
          )
        ).campaignIds,
      ).toEqual([]);
    },
  );

  it('blocks at 23h59 even if the TTL document remains', async () => {
    const changed = await connection
      .db!.collection(C.receipts)
      .updateOne({ userId: user, campaignId: secondCampaign }, [
        {
          $set: {
            deliveredAt: { $subtract: ['$$NOW', 86340000] },
            expiresAt: { $add: ['$$NOW', 60000] },
          },
        },
      ]);
    expect(changed.matchedCount).toBe(1);
    const { feedSessionId } = await store.open(user.toHexString(), 20);
    expect(
      (
        await store.commit(
          user.toHexString(),
          feedSessionId,
          1,
          20,
          ['post_K'],
          [secondCampaign],
          false,
        )
      ).campaignIds,
    ).toEqual([]);
  });

  it('refuses an ineligible user without allocating a session', async () => {
    const blocked = new mongo.ObjectId();
    await connection
      .db!.collection('users')
      .insertOne({ _id: blocked, status: 'banned', isDeleted: false });
    await expect(store.open(blocked.toHexString(), 20)).rejects.toThrow(
      'SPONSORED_FEED_USER_UNAVAILABLE',
    );
    expect(
      await connection
        .db!.collection(C.sessions)
        .countDocuments({ userId: blocked }),
    ).toBe(0);
  });

  it('fails closed without a unique receipt index', async () => {
    await connection
      .db!.collection(C.receipts)
      .dropIndex('sponsored_user_campaign');
    try {
      await expect(
        new SponsoredDeliveryStore(connection).open(user.toHexString(), 20),
      ).rejects.toThrow('SPONSORED_DELIVERY_INDEXES_REQUIRED');
    } finally {
      await store.prepareIndexes();
    }
  });
});
