import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { SponsoredPost } from './sponsored-post.schema';
import {
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from './sponsored-post.constants';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';
import {
  SponsoredActivationService,
  SponsoredHealthProof,
} from './sponsored-activation.service';
import {
  Lane,
  SponsoredJob,
  SponsoredLeaseLost,
  SponsoredSchedulerStore,
  SCHEDULER_BATCH,
} from './sponsored-scheduler.store';

@Injectable()
export class SponsoredSchedulerService {
  private readonly logger = new Logger(SponsoredSchedulerService.name);
  private running = false;
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
    private readonly store: SponsoredSchedulerStore,
    private readonly writer: SponsoredPostWriterService,
    private readonly activation: SponsoredActivationService,
    private readonly config: ConfigService,
  ) {}
  @Cron('*/15 * * * * *', { name: 'sponsored-lifecycle' })
  async scheduledTick(): Promise<void> {
    if (
      this.config.get<string>('SPONSORED_SCHEDULER_ENABLED') !== 'true' ||
      this.running
    )
      return;
    this.running = true;
    try {
      await this.tick();
    } catch {
      this.logger.error('SPONSORED_SCHEDULER_TICK_FAILED');
    } finally {
      this.running = false;
    }
  }
  /** Trusted worker entry; tests call this without enabling the cron. */
  async tick(): Promise<number> {
    const lease = await this.store.acquire();
    if (!lease) return 0;
    const started = performance.now();
    let processed = 0;
    try {
      for (const lane of ['scheduled', 'active', 'paused'] as const)
        await this.discover(lease.token, lane);
      const now = await this.store.fence(lease.token);
      const jobs = await this.store.jobs
        .find({ state: 'pending', nextAttemptAt: { $lte: now } })
        .sort({ nextAttemptAt: 1, _id: 1 })
        .hint('sponsored_jobs_due')
        .limit(SCHEDULER_BATCH)
        .toArray();
      for (const job of jobs) {
        if (performance.now() - started > 45000) break;
        await this.process(job, lease.token);
        processed++;
      }
      return processed;
    } finally {
      await this.store.release(lease.token);
    }
  }
  private async discover(token: string, lane: Lane): Promise<void> {
    await this.connection.transaction(async (session) => {
      const now = await this.store.fence(token, session);
      const control = await this.store.control.findOne(
        { _id: 'lifecycle' },
        { session },
      );
      const cursor = control?.cursors[lane];
      const field = lane === 'scheduled' ? 'startAt' : 'endAt';
      const rows = await this.posts
        .find({
          status: lane,
          [field]: { $lte: now },
          ...(cursor
            ? {
                $or: [
                  { [field]: { $gt: cursor.at, $lte: now } },
                  { [field]: cursor.at, publicId: { $gt: cursor.publicId } },
                ],
              }
            : {}),
        })
        .select(`publicId version startAt endAt`)
        .sort({ [field]: 1, publicId: 1 })
        .hint(
          lane === 'scheduled'
            ? 'sponsored_status_start_public_id'
            : 'sponsored_status_end_public_id',
        )
        .limit(SCHEDULER_BATCH)
        .session(session)
        .lean()
        .exec();
      for (const row of rows) {
        const kind =
          lane === 'scheduled' && row.endAt > now ? 'activate' : 'expire';
        await this.store.jobs.updateOne(
          { _id: `${row.publicId}:${row.version}:${kind}` },
          {
            $setOnInsert: {
              publicId: row.publicId,
              version: row.version,
              kind,
              state: 'pending',
              attempts: 0,
              nextAttemptAt: now,
            },
          },
          { upsert: true, session },
        );
      }
      const last = rows[rows.length - 1];
      await this.store.control.updateOne(
        { _id: 'lifecycle', token },
        {
          $set: {
            [`cursors.${lane}`]:
              rows.length === SCHEDULER_BATCH
                ? { at: last[field], publicId: last.publicId }
                : null,
          },
        },
        { session },
      );
    });
  }
  private async process(job: SponsoredJob, token: string): Promise<void> {
    try {
      const probeTime = await this.store.fence(token);
      const snapshot = await this.posts
        .findOne({ publicId: job.publicId })
        .lean()
        .exec();
      let proof: SponsoredHealthProof | undefined;
      if (
        snapshot?.version === job.version &&
        snapshot.status === Status.SCHEDULED &&
        snapshot.endAt > probeTime
      )
        proof = await this.activation.probe(job.publicId, job.version);
      await this.connection.transaction(async (session) => {
        const now = await this.store.fence(token, session);
        const currentJob = await this.store.jobs.findOne(
          { _id: job._id, state: 'pending' },
          { session },
        );
        if (!currentJob) return;
        const post = await this.posts
          .findOne({ publicId: job.publicId })
          .session(session)
          .lean()
          .exec();
        if (post?.version === job.version) {
          const options = {
            session,
            execution: this.activation.execution(proof, now),
            correlationId: `corr_scheduler_${job.publicId}_${job.version}`,
          };
          if (post.status === Status.SCHEDULED && post.endAt <= now) {
            // Preserve the state allowlist and never briefly publish a missed campaign.
            options.execution = { now };
            const paused = await this.writer.transitionFromWorker(
              post.publicId,
              post.version,
              Action.PAUSE,
              options,
            );
            await this.writer.transitionFromWorker(
              post.publicId,
              paused.version,
              Action.EXPIRE,
              options,
            );
          } else if (post.status === Status.SCHEDULED && post.startAt <= now) {
            if (!proof) throw new Error('SPONSORED_HEALTH_PROOF_REQUIRED');
            await this.writer.transitionFromWorker(
              post.publicId,
              post.version,
              Action.ACTIVATE,
              options,
            );
          } else if (
            [Status.ACTIVE, Status.PAUSED].includes(post.status) &&
            post.endAt <= now
          ) {
            await this.writer.transitionFromWorker(
              post.publicId,
              post.version,
              Action.EXPIRE,
              options,
            );
          } else if (
            [Status.SCHEDULED, Status.ACTIVE, Status.PAUSED].includes(
              post.status,
            )
          ) {
            // Database clock moved backwards after discovery: do not lose the job.
            const due =
              post.status === Status.SCHEDULED ? post.startAt : post.endAt;
            await this.store.jobs.updateOne(
              { _id: job._id },
              { $set: { nextAttemptAt: due } },
              { session },
            );
            return;
          }
        }
        await this.store.complete(job, now, session);
      });
    } catch (error) {
      if (error instanceof SponsoredLeaseLost) throw error;
      const message = error instanceof Error ? error.message : '';
      const obsolete = [
        'SPONSORED_VERSION_CONFLICT',
        'SPONSORED_POST_NOT_FOUND',
      ].includes(message);
      const permanent =
        error instanceof HttpException &&
        error.getStatus() >= 400 &&
        error.getStatus() < 500 &&
        !obsolete &&
        message !== 'SPONSORED_HEALTH_PROOF_STALE';
      await this.connection.transaction(async (session) => {
        const now = await this.store.fence(token, session);
        if (obsolete) return this.store.complete(job, now, session);
        const attempts = job.attempts + 1;
        const manual = permanent || attempts >= 5;
        await this.store.jobs.updateOne(
          { _id: job._id, state: 'pending' },
          {
            $set: {
              attempts,
              state: manual ? 'manual_review' : 'pending',
              errorCode: permanent
                ? 'ELIGIBILITY_REJECTED'
                : 'TRANSIENT_FAILURE',
              nextAttemptAt: new Date(
                now.getTime() + Math.min(900000, 60000 * 2 ** (attempts - 1)),
              ),
            },
          },
          { session },
        );
        if (manual)
          this.logger.error('SPONSORED_SCHEDULER_MANUAL_REVIEW_REQUIRED');
      });
    }
  }
}
