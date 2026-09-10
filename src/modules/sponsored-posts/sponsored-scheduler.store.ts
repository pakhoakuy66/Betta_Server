import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ClientSession, mongo } from 'mongoose';
import { randomUUID } from 'crypto';

export class SponsoredLeaseLost extends Error {}
export type Lane = 'scheduled' | 'active' | 'paused';
export type Cursor = { at: Date; publicId: string };
type Control = {
  _id: string;
  token: string;
  leaseUntil: Date;
  observedAt: Date;
  cursors: Partial<Record<Lane, Cursor | null>>;
};
export type SponsoredJob = {
  _id: string;
  publicId: string;
  version: number;
  state: 'pending' | 'done' | 'manual_review';
  attempts: number;
  nextAttemptAt: Date;
  errorCode?: string;
  expiresAt?: Date;
  kind: 'activate' | 'expire';
};
export const SCHEDULER_BATCH = 25;
export const SCHEDULER_LEASE_MS = 90000;

/** Technical collections only. Campaign state is always changed through writer. */
@Injectable()
export class SponsoredSchedulerStore {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  get control(): mongo.Collection<Control> {
    if (!this.connection.db) throw new Error('SPONSORED_DATABASE_UNAVAILABLE');
    return this.connection.db.collection<Control>(
      'sponsored_scheduler_control',
    );
  }
  get jobs(): mongo.Collection<SponsoredJob> {
    if (!this.connection.db) throw new Error('SPONSORED_DATABASE_UNAVAILABLE');
    return this.connection.db.collection<SponsoredJob>(
      'sponsored_scheduler_jobs',
    );
  }
  async initialize(): Promise<void> {
    try {
      await this.control.updateOne(
        { _id: 'lifecycle' },
        {
          $setOnInsert: {
            token: '',
            leaseUntil: new Date(0),
            observedAt: new Date(0),
            cursors: {},
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof mongo.MongoServerError && error.code === 11000))
        throw error;
    }
  }
  /** Run explicitly before enabling scheduler; never builds indexes on a cron tick. */
  async ensureIndexes(): Promise<void> {
    await this.initialize();
    await this.jobs.createIndex(
      { state: 1, nextAttemptAt: 1, _id: 1 },
      { name: 'sponsored_jobs_due' },
    );
    await this.jobs.createIndex(
      { expiresAt: 1 },
      { name: 'sponsored_jobs_done_ttl', expireAfterSeconds: 0 },
    );
  }
  async now(session?: ClientSession): Promise<Date> {
    const row = await this.control
      .aggregate<{
        now: Date;
      }>([{ $match: { _id: 'lifecycle' } }, { $project: { now: '$$NOW' } }], {
        session,
      })
      .next();
    if (!row) throw new Error('SPONSORED_SCHEDULER_NOT_INITIALIZED');
    return row.now;
  }
  async acquire(): Promise<Control | null> {
    await this.initialize();
    return this.control.findOneAndUpdate(
      { _id: 'lifecycle', $expr: { $lte: ['$leaseUntil', '$$NOW'] } },
      [
        {
          $set: {
            token: randomUUID(),
            observedAt: '$$NOW',
            leaseUntil: { $add: ['$$NOW', SCHEDULER_LEASE_MS] },
          },
        },
      ],
      { returnDocument: 'after' },
    );
  }
  async fence(token: string, session?: ClientSession): Promise<Date> {
    const row = await this.control.findOneAndUpdate(
      { _id: 'lifecycle', token, $expr: { $gt: ['$leaseUntil', '$$NOW'] } },
      [
        {
          $set: {
            observedAt: '$$NOW',
            leaseUntil: { $add: ['$$NOW', SCHEDULER_LEASE_MS] },
          },
        },
      ],
      { session, returnDocument: 'after' },
    );
    if (!row) throw new SponsoredLeaseLost('SPONSORED_LEASE_LOST');
    return row.observedAt;
  }
  async release(token: string): Promise<void> {
    await this.control.updateOne(
      { _id: 'lifecycle', token },
      { $set: { token: '', leaseUntil: new Date(0) } },
    );
  }
  async complete(
    job: SponsoredJob,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.jobs.updateOne(
      { _id: job._id, state: 'pending' },
      {
        $set: {
          state: 'done',
          expiresAt: new Date(now.getTime() + 7 * 86400000),
        },
      },
      { session },
    );
  }
}
