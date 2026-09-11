import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import {
  DELIVERY,
  issueFeedSessionId,
  sessionDigest,
  uniqueIds,
  validPage,
} from './sponsored-delivery.policy';
import {
  SPONSORED_POST_COLLECTION,
  SPONSORED_PUBLIC_ID_PATTERN,
} from './sponsored-post.constants';
import { buildEligibleUserMatch } from '../users/policies/user-eligibility.policy';

type SessionRow = {
  _id: string;
  userId: mongo.ObjectId;
  limit: number;
  nextPage: number;
  revision: number;
  createdAt: Date;
  expiresAt: Date;
};
type ReceiptRow = {
  userId: mongo.ObjectId;
  campaignId: string;
  feedSessionId: string;
  deliveredAt: Date;
  expiresAt: Date;
};
type PageRow = {
  feedSessionId: string;
  page: number;
  organicIds: string[];
  campaignIds: string[];
  hasMore: boolean;
  expiresAt: Date;
};
export const DELIVERY_COLLECTIONS = Object.freeze({
  sessions: 'sponsored_feed_sessions',
  receipts: 'sponsored_delivery_receipts',
  pages: 'sponsored_feed_pages',
});
export type DeliveryPage = Readonly<{
  organicIds: readonly string[];
  campaignIds: readonly string[];
  page: number;
  limit: number;
  hasMore: boolean;
}>;
/**
 * INTERNAL boundary for Task05. No HTTP controller and no client-controlled candidates.
 * The authenticated Home Feed orchestrator owns organic selection, spacing and live
 * eligibility revalidation before serialization. This store never writes User Posts.
 */
@Injectable()
export class SponsoredDeliveryStore {
  private indexesReady = false;
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get db() {
    if (!this.connection.db)
      throw new Error('SPONSORED_DELIVERY_DATABASE_UNAVAILABLE');
    return this.connection.db;
  }
  private get sessions() {
    return this.db.collection<SessionRow>(DELIVERY_COLLECTIONS.sessions);
  }
  private get receipts() {
    return this.db.collection<ReceiptRow>(DELIVERY_COLLECTIONS.receipts);
  }
  private get pages() {
    return this.db.collection<PageRow>(DELIVERY_COLLECTIONS.pages);
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesReady) return;
    const receiptIndexes = await this.receipts.indexes();
    const pageIndexes = await this.pages.indexes();
    if (
      !receiptIndexes.some(
        (index) =>
          index.unique === true &&
          JSON.stringify(index.key) ===
            JSON.stringify({ userId: 1, campaignId: 1 }),
      ) ||
      !pageIndexes.some(
        (index) =>
          index.unique === true &&
          JSON.stringify(index.key) ===
            JSON.stringify({ feedSessionId: 1, page: 1 }),
      )
    )
      throw new Error('SPONSORED_DELIVERY_INDEXES_REQUIRED');
    for (const collection of [this.sessions, this.receipts, this.pages]) {
      if (
        !(await collection.indexes()).some(
          (index) =>
            index.expireAfterSeconds === 0 &&
            JSON.stringify(index.key) === JSON.stringify({ expiresAt: 1 }),
        )
      )
        throw new Error('SPONSORED_DELIVERY_TTL_REQUIRED');
    }
    this.indexesReady = true;
  }

  private async now(): Promise<Date> {
    const reply = await this.db.command({ hello: 1 });
    const value: unknown = reply.localTime;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new Error('SPONSORED_DATABASE_CLOCK_UNAVAILABLE');
    return value;
  }

  /** Deployment step only; never called per request. Additive indexes, no syncIndexes. */
  async prepareIndexes(): Promise<void> {
    await this.sessions.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'sponsored_session_expiry' },
    );
    await this.receipts.createIndex(
      { userId: 1, campaignId: 1 },
      { unique: true, name: 'sponsored_user_campaign' },
    );
    await this.receipts.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'sponsored_receipt_expiry' },
    );
    await this.pages.createIndex(
      { feedSessionId: 1, page: 1 },
      { unique: true, name: 'sponsored_session_page' },
    );
    await this.pages.createIndex(
      { feedSessionId: 1, organicIds: 1 },
      { name: 'sponsored_organic_dedupe' },
    );
    await this.pages.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'sponsored_page_expiry' },
    );
  }

  private userId(value: string): mongo.ObjectId {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value))
      throw new NotFoundException('SPONSORED_FEED_SESSION_NOT_FOUND');
    return new mongo.ObjectId(value);
  }

  private async eligibleUser(
    userId: mongo.ObjectId,
    now: Date,
    session?: mongo.ClientSession,
  ): Promise<void> {
    const user = await this.db
      .collection('users')
      .findOne(
        { _id: userId, ...buildEligibleUserMatch(now) },
        { projection: { _id: 1 }, session },
      );
    if (!user) throw new NotFoundException('SPONSORED_FEED_USER_UNAVAILABLE');
  }

  async open(
    user: string,
    limit: number,
  ): Promise<{ feedSessionId: string; expiresAt: Date }> {
    await this.ensureIndexes();
    validPage(1, limit);
    const userId = this.userId(user);
    const now = await this.now();
    await this.eligibleUser(userId, now);
    const feedSessionId = issueFeedSessionId();
    const expiresAt = new Date(now.getTime() + DELIVERY.sessionMs);
    await this.sessions.insertOne({
      _id: sessionDigest(feedSessionId),
      userId,
      limit,
      nextPage: 1,
      revision: 0,
      createdAt: now,
      expiresAt,
    });
    return { feedSessionId, expiresAt };
  }

  private result(row: PageRow, limit: number): DeliveryPage {
    return {
      organicIds: [...row.organicIds],
      campaignIds: [...row.campaignIds],
      page: row.page,
      limit,
      hasMore: row.hasMore,
    };
  }

  /** Read saved plan BEFORE selecting organic posts/candidates again on a retry. */
  async read(
    user: string,
    token: string,
    page: number,
    limit: number,
  ): Promise<DeliveryPage | null> {
    await this.ensureIndexes();
    validPage(page, limit);
    const userId = this.userId(user);
    const now = await this.now();
    await this.eligibleUser(userId, now);
    const digest = sessionDigest(token);
    const owner = await this.sessions.findOne({
      _id: digest,
      userId,
      expiresAt: { $gt: now },
    });
    if (!owner) throw new NotFoundException('SPONSORED_FEED_SESSION_NOT_FOUND');
    if (owner.limit !== limit)
      throw new ConflictException('SPONSORED_FEED_LIMIT_CHANGED');
    const saved = await this.pages.findOne({
      feedSessionId: digest,
      page,
      expiresAt: { $gt: now },
    });
    return saved ? this.result(saved, limit) : null;
  }

  /**
   * Commit one internal organic page and requested campaign candidates atomically.
   * Returned campaignIds may be shorter: cooldown/eligibility always wins.
   * A replay returns the original IDs; the caller must revalidate them before rendering.
   * A receipt means server allocation, NOT a browser impression or click.
   */
  async commit(
    user: string,
    token: string,
    page: number,
    limit: number,
    organicIds: readonly string[],
    candidateIds: readonly string[],
    hasMore: boolean,
  ): Promise<DeliveryPage> {
    await this.ensureIndexes();
    validPage(page, limit);
    uniqueIds(organicIds, /^post_[A-Za-z0-9_-]{1,64}$/, limit);
    uniqueIds(
      candidateIds,
      SPONSORED_PUBLIC_ID_PATTERN,
      DELIVERY.maxCandidates,
    );
    if (
      typeof hasMore !== 'boolean' ||
      (organicIds.length === 0 && candidateIds.length > 0)
    )
      throw new ConflictException('SPONSORED_DELIVERY_PLAN_INVALID');
    const userId = this.userId(user);
    const digest = sessionDigest(token);
    // Unique receipt races across sessions can raise E11000 instead of a labelled
    // write conflict. Retry the entire transaction, never just the failed insert.
    for (let attempt = 0; attempt < 3; attempt++) {
      const transaction = this.connection.getClient().startSession();
      try {
        const result = await transaction.withTransaction(
          async () => {
            const now = await this.now();
            await this.eligibleUser(userId, now, transaction);
            const owner = await this.sessions.findOneAndUpdate(
              { _id: digest, userId, expiresAt: { $gt: now } },
              { $inc: { revision: 1 } },
              { session: transaction, returnDocument: 'after' },
            );
            if (!owner)
              throw new NotFoundException('SPONSORED_FEED_SESSION_NOT_FOUND');
            if (owner.limit !== limit)
              throw new ConflictException('SPONSORED_FEED_LIMIT_CHANGED');
            const saved = await this.pages.findOne(
              { feedSessionId: digest, page },
              { session: transaction },
            );
            if (saved) return this.result(saved, limit);
            if (owner.nextPage !== page)
              throw new ConflictException('SPONSORED_FEED_PAGE_OUT_OF_ORDER');
            if (
              organicIds.length &&
              (await this.pages.findOne(
                { feedSessionId: digest, organicIds: { $in: [...organicIds] } },
                { session: transaction, projection: { _id: 1 } },
              ))
            )
              throw new ConflictException('SPONSORED_ORGANIC_PAGE_OVERLAP');
            const selected: string[] = [];
            for (const campaignId of candidateIds) {
              const campaign = await this.db
                .collection(SPONSORED_POST_COLLECTION)
                .findOne(
                  {
                    publicId: campaignId,
                    status: 'active',
                    deletedAt: null,
                    assetHealth: 'healthy',
                    startAt: { $lte: now },
                    endAt: { $gt: now },
                  },
                  { projection: { _id: 1 }, session: transaction },
                );
              if (!campaign) continue;
              const existing = await this.receipts.findOne(
                { userId, campaignId },
                { session: transaction },
              );
              if (
                existing &&
                (existing.expiresAt > now || existing.feedSessionId === digest)
              )
                continue;
              // TTL deletion is asynchronous. Logical expiry must work even before TTL runs.
              if (existing)
                await this.receipts.deleteOne(
                  { userId, campaignId, expiresAt: { $lte: now } },
                  { session: transaction },
                );
              await this.receipts.insertOne(
                {
                  userId,
                  campaignId,
                  feedSessionId: digest,
                  deliveredAt: now,
                  expiresAt: new Date(now.getTime() + DELIVERY.cooldownMs),
                },
                { session: transaction },
              );
              selected.push(campaignId);
            }
            const row: PageRow = {
              feedSessionId: digest,
              page,
              organicIds: [...organicIds],
              campaignIds: selected,
              hasMore,
              expiresAt: owner.expiresAt,
            };
            await this.pages.insertOne(row, { session: transaction });
            await this.sessions.updateOne(
              { _id: digest },
              { $inc: { nextPage: 1 } },
              { session: transaction },
            );
            return this.result(row, limit);
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          },
        );
        if (!result) throw new Error('SPONSORED_DELIVERY_TRANSACTION_ABORTED');
        return result;
      } catch (error) {
        if (
          error instanceof mongo.MongoServerError &&
          error.code === 11000 &&
          attempt < 2
        )
          continue;
        throw error;
      } finally {
        await transaction.endSession();
      }
    }
    throw new Error('SPONSORED_DELIVERY_RETRY_EXHAUSTED');
  }
}
