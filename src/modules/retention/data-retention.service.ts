import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type {
  AnyBulkWriteOperation,
  Document as MongoDocument,
  Filter,
} from 'mongodb';
import { Connection, Types } from 'mongoose';
import {
  CleanupMode,
  CollectionCleanupResult,
  DataRetentionResult,
  RunDataRetentionOptions,
} from './retention.types';
import { ReportEvidenceRetentionService } from './report-evidence-retention.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DOCUMENTS = 1_000;
const MAX_DOCUMENTS_LIMIT = 10_000;
const PRODUCTION_CONFIRMATION = 'CONFIRM_PRODUCTION_RETENTION_CLEANUP';
const BACKUP_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const TEST_MARKER_PATTERN = /^codex_cleanup_/;

const RETENTION_DAYS = {
  engagementEvents: 180,
  weeklyRecaps: 365,
  weeklyRecapRuns: 365,
  streakHistories: 365,
} as const;

const TEST_MARKER_COLLECTIONS = [
  'users',
  'posts',
  'relationships',
  'blocks',
  'reactions',
  'post_shares',
  'notifications',
  'engagement_events',
  'weekly_recaps',
  'streak_histories',
  'report_cooldowns',
  'reports',
  'system_reports',
  'systemreports',
  'weekly_recap_runs',
  'authratelimits',
] as const;

type WeeklyRecapRunRecord = {
  _id: Types.ObjectId;
  status: string;
  weekStart: Date;
  weekEnd: Date;
  timezone: string;
};

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    private readonly reportEvidenceRetention: ReportEvidenceRetentionService,
  ) {}

  async run(
    options: RunDataRetentionOptions = {},
  ): Promise<DataRetentionResult> {
    const database = this.connection.db;

    if (!database) {
      throw new Error('MongoDB chưa sẵn sàng');
    }

    const mode = options.mode ?? 'retention';
    const execute = options.execute ?? false;
    const maxDocuments = this.normalizeBudget(options.maxDocuments);
    const now = options.now ?? new Date();

    this.assertSafeExecution(
      mode,
      execute,
      options.confirmation,
      options.backupReference,
    );

    const results: CollectionCleanupResult[] = [];
    let remainingBudget = maxDocuments;
    let invalidEngagementEvents = 0;
    let stoppedBeforeLastStep = false;

    if (mode === 'test-marker') {
      for (const collectionName of TEST_MARKER_COLLECTIONS) {
        if (remainingBudget === 0) {
          stoppedBeforeLastStep = true;
          break;
        }

        const result = await this.cleanupTestMarkerCollection(
          collectionName,
          remainingBudget,
          execute,
        );
        results.push(result);
        remainingBudget -= execute ? result.processed : result.planned;
      }
    } else {
      const steps: Array<
        () => Promise<
          | CollectionCleanupResult
          | {
              result: CollectionCleanupResult;
              invalid: number;
            }
        >
      > = [
        () =>
          this.reportEvidenceRetention.reconcileExhaustedClaims(
            remainingBudget,
            execute,
            now,
          ),
        () =>
          this.reportEvidenceRetention.reconcileMissingPostEvidence(
            remainingBudget,
            execute,
            now,
          ),
        () =>
          this.reportEvidenceRetention.purgeReportEvidence(
            remainingBudget,
            execute,
            now,
          ),
        () =>
          this.reportEvidenceRetention.purgeSystemReportEvidence(
            remainingBudget,
            execute,
            now,
          ),
        () =>
          this.reportEvidenceRetention.deleteSafeReportMetadata(
            remainingBudget,
            execute,
            now,
          ),
        () =>
          this.reportEvidenceRetention.deleteSafeSystemReportMetadata(
            remainingBudget,
            execute,
            now,
          ),
        () => this.cleanupEngagementEvents(remainingBudget, execute, now),
        () =>
          this.cleanupGenericByDate(
            'weekly_recaps',
            { weekEnd: { $lt: this.cutoff(now, RETENTION_DAYS.weeklyRecaps) } },
            remainingBudget,
            execute,
          ),
        () => this.cleanupWeeklyRecapRuns(remainingBudget, execute, now),
        () =>
          this.cleanupGenericByDate(
            'streak_histories',
            {
              createdAt: {
                $lt: this.cutoff(now, RETENTION_DAYS.streakHistories),
              },
            },
            remainingBudget,
            execute,
          ),
      ];

      for (const step of steps) {
        if (remainingBudget === 0) {
          stoppedBeforeLastStep = true;
          break;
        }

        const stepOutput = await step();
        const result = 'result' in stepOutput ? stepOutput.result : stepOutput;

        if ('result' in stepOutput) {
          invalidEngagementEvents += stepOutput.invalid;
        }

        results.push(result);
        remainingBudget -= execute ? result.processed : result.planned;
      }
    }

    const processed = this.sum(results, 'processed');
    const updated = this.sum(results, 'updated');
    const deleted = this.sum(results, 'deleted');
    const failed = this.sum(results, 'failed');
    const lostOwnership = this.sum(results, 'lostOwnership');
    const manualReview = this.sum(results, 'manualReview');
    const requiresIntervention =
      failed > 0 || lostOwnership > 0 || manualReview > 0;
    const hasMore =
      stoppedBeforeLastStep ||
      results.some((result) => result.truncated || result.failed > 0);

    const result: DataRetentionResult = {
      success: !requiresIntervention,
      mode,
      execute,
      database: database.databaseName,
      maxDocuments,
      processed,
      updated,
      deleted,
      failed,
      lostOwnership,
      manualReview,
      requiresIntervention,
      hasMore,
      invalidEngagementEvents,
      backupReferenceAccepted:
        execute && mode === 'retention' && Boolean(options.backupReference),
      results,
    };

    this.logSummary(result);

    return result;
  }

  private async cleanupTestMarkerCollection(
    collectionName: string,
    budget: number,
    execute: boolean,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const database = this.connection.db;

    if (!database) throw new Error('MongoDB chưa sẵn sàng');

    const collection = database.collection(collectionName);
    const filter = { __cleanupTestRun: TEST_MARKER_PATTERN };
    const observedEligible = await collection.countDocuments(filter, {
      limit: budget + 1,
    });
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return this.result(collectionName, observedEligible, planned, startedAt, {
        truncated: observedEligible > budget,
      });
    }

    const candidates = await collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(planned)
      .toArray();
    const ids = candidates.map((candidate) => candidate._id);
    const deletion = await collection.deleteMany({
      _id: { $in: ids },
      __cleanupTestRun: TEST_MARKER_PATTERN,
    });

    return this.result(collectionName, observedEligible, planned, startedAt, {
      processed: ids.length,
      deleted: deletion.deletedCount,
      skipped: ids.length - deletion.deletedCount,
      truncated: observedEligible > budget,
    });
  }

  private async cleanupEngagementEvents(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<{ result: CollectionCleanupResult; invalid: number }> {
    const startedAt = Date.now();
    const database = this.requireDatabase();
    const events = database.collection('engagement_events');
    const runs = database.collection<WeeklyRecapRunRecord>('weekly_recap_runs');
    const cutoff = this.cutoff(now, RETENTION_DAYS.engagementEvents);
    const invalid = await events.countDocuments({
      $or: [
        { weekStart: { $exists: false } },
        { weekEnd: { $exists: false } },
        { timezone: { $exists: false } },
      ],
    });
    const completedRuns = await runs
      .find(
        { status: 'completed', weekEnd: { $lt: cutoff } },
        { projection: { weekStart: 1, timezone: 1 } },
      )
      .sort({ weekEnd: 1, _id: 1 })
      .limit(Math.min(budget + 1, 2_000))
      .toArray();
    const weekFilters: Array<{
      weekStart: Date;
      timezone: string;
    }> = completedRuns.map((run) => ({
      weekStart: run.weekStart,
      timezone: run.timezone,
    }));
    const filter: Filter<MongoDocument> = {
      weekEnd: { $lt: cutoff },
      ...(weekFilters.length > 0 ? { $or: weekFilters } : { _id: { $in: [] } }),
    };
    const observedEligible = await events.countDocuments(filter, {
      limit: budget + 1,
    });
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return {
        result: this.result(
          'engagement_events',
          observedEligible,
          planned,
          startedAt,
          { truncated: observedEligible > budget },
        ),
        invalid,
      };
    }

    const candidates = await events
      .find(filter, { projection: { _id: 1 } })
      .sort({ weekEnd: 1, _id: 1 })
      .limit(planned)
      .toArray();
    const ids = candidates.map((candidate) => candidate._id);
    const deletion = await events.deleteMany({
      _id: { $in: ids },
      ...filter,
    });

    return {
      result: this.result(
        'engagement_events',
        observedEligible,
        planned,
        startedAt,
        {
          processed: ids.length,
          deleted: deletion.deletedCount,
          skipped: ids.length - deletion.deletedCount,
          truncated: observedEligible > budget,
        },
      ),
      invalid,
    };
  }

  private async cleanupWeeklyRecapRuns(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const database = this.requireDatabase();
    const runs = database.collection<WeeklyRecapRunRecord>('weekly_recap_runs');
    const events = database.collection('engagement_events');
    const reactions = database.collection('reactions');
    const baseFilter = {
      status: 'completed',
      weekEnd: { $lt: this.cutoff(now, RETENTION_DAYS.weeklyRecapRuns) },
    };
    const candidates = await runs
      .find(baseFilter, {
        projection: {
          _id: 1,
          weekStart: 1,
          weekEnd: 1,
          timezone: 1,
        },
      })
      .sort({ weekEnd: 1, _id: 1 })
      .limit(budget + 1)
      .toArray();
    const deletable: typeof candidates = [];

    for (const candidate of candidates) {
      const hasEvents = await events.findOne(
        {
          weekStart: candidate.weekStart,
          timezone: candidate.timezone,
        },
        { projection: { _id: 1 } },
      );

      if (hasEvents) {
        continue;
      }

      const hasReactions = await reactions.findOne(
        {
          createdAt: {
            $gte: candidate.weekStart,
            $lt: candidate.weekEnd,
          },
        },
        { projection: { _id: 1 } },
      );

      if (!hasReactions) {
        deletable.push(candidate);
      }
    }

    const observedEligible = deletable.length;
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return this.result(
        'weekly_recap_runs',
        observedEligible,
        planned,
        startedAt,
        { truncated: observedEligible > budget },
      );
    }

    const ids = deletable.slice(0, planned).map((candidate) => candidate._id);
    const operations: AnyBulkWriteOperation<WeeklyRecapRunRecord>[] = ids.map(
      (_id) => ({
        deleteOne: {
          filter: {
            _id,
            ...baseFilter,
          },
        },
      }),
    );
    const deletion = operations.length
      ? await runs.bulkWrite(operations, { ordered: false })
      : null;
    const deleted = deletion?.deletedCount ?? 0;

    return this.result(
      'weekly_recap_runs',
      observedEligible,
      planned,
      startedAt,
      {
        processed: ids.length,
        deleted,
        skipped: ids.length - deleted,
        truncated: observedEligible > budget,
      },
    );
  }

  private async cleanupGenericByDate(
    collectionName: string,
    filter: Record<string, unknown>,
    budget: number,
    execute: boolean,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const collection = this.requireDatabase().collection(collectionName);
    const observedEligible = await collection.countDocuments(filter, {
      limit: budget + 1,
    });
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return this.result(collectionName, observedEligible, planned, startedAt, {
        truncated: observedEligible > budget,
      });
    }

    const candidates = await collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(planned)
      .toArray();
    const ids = candidates.map((candidate) => candidate._id);
    const deletion = await collection.deleteMany({
      $and: [filter, { _id: { $in: ids } }],
    });

    return this.result(collectionName, observedEligible, planned, startedAt, {
      processed: ids.length,
      deleted: deletion.deletedCount,
      skipped: ids.length - deletion.deletedCount,
      truncated: observedEligible > budget,
    });
  }

  private result(
    collection: string,
    eligible: number,
    planned: number,
    startedAt: number,
    values: Partial<CollectionCleanupResult> = {},
  ): CollectionCleanupResult {
    return {
      collection,
      eligible,
      planned,
      processed: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      lostOwnership: 0,
      manualReview: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      ...values,
    };
  }

  private normalizeBudget(value?: number): number {
    const budget = value ?? DEFAULT_MAX_DOCUMENTS;
    if (
      !Number.isInteger(budget) ||
      budget < 1 ||
      budget > MAX_DOCUMENTS_LIMIT
    ) {
      throw new Error(
        `maxDocuments phải là số nguyên từ 1 đến ${MAX_DOCUMENTS_LIMIT}`,
      );
    }
    return budget;
  }

  private assertSafeExecution(
    mode: CleanupMode,
    execute: boolean,
    confirmation?: string,
    backupReference?: string,
  ): void {
    if (mode === 'test-marker' && process.env.NODE_ENV === 'production') {
      throw new Error('Không được cleanup test marker trong production');
    }
    if (
      execute &&
      mode === 'retention' &&
      !BACKUP_REFERENCE_PATTERN.test(backupReference ?? '')
    ) {
      throw new Error(
        'Retention execute yêu cầu --backup-reference hợp lệ (8..128 ký tự an toàn)',
      );
    }
    if (
      execute &&
      process.env.NODE_ENV === 'production' &&
      confirmation !== PRODUCTION_CONFIRMATION
    ) {
      throw new Error(
        `Production cleanup yêu cầu xác nhận ${PRODUCTION_CONFIRMATION}`,
      );
    }
  }

  private requireDatabase() {
    const database = this.connection.db;
    if (!database) throw new Error('MongoDB chưa sẵn sàng');
    return database;
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
  }

  private sum(
    results: CollectionCleanupResult[],
    field:
      | 'processed'
      | 'updated'
      | 'deleted'
      | 'failed'
      | 'lostOwnership'
      | 'manualReview',
  ): number {
    return results.reduce((total, result) => total + result[field], 0);
  }

  private logSummary(result: DataRetentionResult): void {
    const summary = [
      'Retention cleanup completed',
      `mode=${result.mode}`,
      `execute=${result.execute}`,
      `database=${result.database}`,
      `processed=${result.processed}`,
      `updated=${result.updated}`,
      `deleted=${result.deleted}`,
      `failed=${result.failed}`,
      `lostOwnership=${result.lostOwnership}`,
      `manualReview=${result.manualReview}`,
      `requiresIntervention=${result.requiresIntervention}`,
      `hasMore=${result.hasMore}`,
    ].join(' ');

    if (result.requiresIntervention) this.logger.error(summary);
    else if (result.hasMore) this.logger.warn(summary);
    else this.logger.log(summary);
  }
}
