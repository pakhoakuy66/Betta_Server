import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type {
  AnyBulkWriteOperation,
  Document as MongoDocument,
  Filter,
} from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import {
  RetentionCleanupStatus,
  SystemReport,
  SystemReportStatus,
} from '../reports/schemas/system-report.schema';
import { UploadsService } from '../uploads/services/uploads.service';
import {
  CleanupMode,
  CollectionCleanupResult,
  DataRetentionResult,
  RunDataRetentionOptions,
} from './retention.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DOCUMENTS = 1_000;
const MAX_DOCUMENTS_LIMIT = 10_000;
const SYSTEM_REPORT_LOCK_MS = 10 * 60 * 1000;
const SYSTEM_REPORT_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const SYSTEM_REPORT_MAX_ATTEMPTS = 5;
const PRODUCTION_CONFIRMATION = 'CONFIRM_PRODUCTION_RETENTION_CLEANUP';
const TEST_MARKER_PATTERN = /^codex_cleanup_/;

const RETENTION_DAYS = {
  engagementEvents: 180,
  weeklyRecaps: 365,
  weeklyRecapRuns: 365,
  streakHistories: 365,
  systemReports: 365,
  reports: 730,
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

type SystemReportCandidate = {
  _id: Types.ObjectId;
  evidenceImages?: { publicId?: string }[];
  retentionAttempts?: number;
};

type WeeklyRecapRunRecord = {
  _id: Types.ObjectId;
  status: string;
  weekStart: Date;
  weekEnd: Date;
  timezone: string;
};

type SystemReportFilter = {
  _id?: Types.ObjectId | { $in?: Types.ObjectId[] };
  status?: { $in?: SystemReportStatus[] };
  terminalAt?: { $lt?: Date } | null;
  retentionAttempts?: {
    $lt?: number;
    $gte?: number;
    $exists?: boolean;
  };
  retentionCleanupStatus?: RetentionCleanupStatus | { $exists?: boolean };
  retentionLockedUntil?: { $lte?: Date } | { $exists?: boolean } | null;
  $and?: SystemReportFilter[];
  $or?: SystemReportFilter[];
};

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(SystemReport.name)
    private readonly systemReportModel: Model<SystemReport>,
    private readonly uploadsService: UploadsService,
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

    this.assertSafeExecution(mode, execute, options.confirmation);

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
          this.reconcileExhaustedSystemReportClaims(
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
        () =>
          this.cleanupGenericByDate(
            'reports',
            {
              status: { $in: ['resolved', 'rejected'] },
              terminalAt: {
                $lt: this.cutoff(now, RETENTION_DAYS.reports),
              },
            },
            remainingBudget,
            execute,
          ),
        () => this.cleanupSystemReports(remainingBudget, execute, now),
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
    const hasMore =
      stoppedBeforeLastStep ||
      results.some((result) => result.truncated || result.failed > 0);

    const result: DataRetentionResult = {
      success: failed === 0,
      mode,
      execute,
      database: database.databaseName,
      maxDocuments,
      processed,
      updated,
      deleted,
      failed,
      hasMore,
      invalidEngagementEvents,
      results,
    };

    this.logSummary(result, lostOwnership);

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

  private async reconcileExhaustedSystemReportClaims(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const filter = this.exhaustedSystemReportFilter(now);
    const observedEligible = await this.systemReportModel.countDocuments(
      filter,
      { limit: budget + 1 },
    );
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return this.result(
        'system_reports_manual_review',
        observedEligible,
        planned,
        startedAt,
        { truncated: observedEligible > budget },
      );
    }

    const candidates = await this.systemReportModel
      .find(filter)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(planned)
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const ids = candidates.map((candidate) => candidate._id);
    const update = await this.systemReportModel.updateMany(
      { $and: [filter, { _id: { $in: ids } }] },
      {
        $set: {
          retentionCleanupStatus: RetentionCleanupStatus.MANUAL_REVIEW,
          retentionLockedUntil: null,
          retentionLockToken: null,
          retentionLastError:
            'Cleanup vượt giới hạn retry và cần kiểm tra thủ công',
        },
      },
    );

    return this.result(
      'system_reports_manual_review',
      observedEligible,
      planned,
      startedAt,
      {
        processed: ids.length,
        updated: update.modifiedCount,
        skipped: ids.length - update.modifiedCount,
        truncated: observedEligible > budget,
      },
    );
  }

  private async cleanupSystemReports(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const eligibility = this.systemReportEligibilityFilter(now);
    const observedEligible = await this.systemReportModel.countDocuments(
      eligibility,
      { limit: budget + 1 },
    );
    const planned = Math.min(observedEligible, budget);

    if (!execute || planned === 0) {
      return this.result(
        'system_reports',
        observedEligible,
        planned,
        startedAt,
        { truncated: observedEligible > budget },
      );
    }

    let processed = 0;
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    let lostOwnership = 0;

    for (let index = 0; index < planned; index += 1) {
      const outcome = await this.processOneSystemReport(now);
      if (outcome === 'none') break;
      processed += 1;
      if (outcome === 'deleted') deleted += 1;
      if (outcome === 'skipped') skipped += 1;
      if (outcome === 'failed') failed += 1;
      if (outcome === 'lost') lostOwnership += 1;
    }

    return this.result('system_reports', observedEligible, planned, startedAt, {
      processed,
      deleted,
      skipped,
      failed,
      lostOwnership,
      truncated: observedEligible > budget,
    });
  }

  private async processOneSystemReport(
    now: Date,
  ): Promise<'deleted' | 'failed' | 'lost' | 'skipped' | 'none'> {
    const token = randomUUID();
    const lockedUntil = new Date(now.getTime() + SYSTEM_REPORT_LOCK_MS);
    const claimed = await this.systemReportModel
      .findOneAndUpdate(
        this.systemReportEligibilityFilter(now),
        {
          $set: {
            retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
            retentionLockedUntil: lockedUntil,
            retentionLockToken: token,
            retentionLastError: '',
          },
          $inc: { retentionAttempts: 1 },
        },
        { sort: { terminalAt: 1, _id: 1 }, returnDocument: 'after' },
      )
      .select('_id evidenceImages retentionAttempts')
      .lean<SystemReportCandidate>()
      .exec();

    if (!claimed) return 'none';
    if (!token) throw new Error('Không tạo được retention lock token');

    try {
      const owned = await this.systemReportModel
        .findOne({
          _id: claimed._id,
          ...this.systemReportTerminalFilter(now),
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockToken: token,
          retentionLockedUntil: { $gt: new Date() },
        })
        .select('_id')
        .lean()
        .exec();

      if (!owned) return 'lost';

      await this.uploadsService.deleteImages(
        (claimed.evidenceImages ?? [])
          .map((image) => image.publicId ?? '')
          .filter(Boolean),
        { throwOnError: true },
      );

      const deletion = await this.systemReportModel.deleteOne({
        _id: claimed._id,
        ...this.systemReportTerminalFilter(now),
        retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
        retentionLockToken: token,
      });

      return deletion.deletedCount === 1 ? 'deleted' : 'lost';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = claimed.retentionAttempts ?? 1;
      const finalStatus =
        attempts >= SYSTEM_REPORT_MAX_ATTEMPTS
          ? RetentionCleanupStatus.MANUAL_REVIEW
          : RetentionCleanupStatus.FAILED;
      const release = await this.systemReportModel.updateOne(
        {
          _id: claimed._id,
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockToken: token,
        },
        {
          $set: {
            retentionCleanupStatus: finalStatus,
            retentionLockedUntil:
              finalStatus === RetentionCleanupStatus.FAILED
                ? new Date(Date.now() + SYSTEM_REPORT_RETRY_DELAY_MS)
                : null,
            retentionLockToken: null,
            retentionLastError: message.slice(0, 2_000),
          },
        },
      );

      return release.modifiedCount === 1 ? 'failed' : 'lost';
    }
  }

  private systemReportTerminalFilter(now: Date): SystemReportFilter {
    return {
      status: { $in: [SystemReportStatus.FIXED, SystemReportStatus.CLOSED] },
      terminalAt: {
        $lt: this.cutoff(now, RETENTION_DAYS.systemReports),
      },
    };
  }

  private systemReportEligibilityFilter(now: Date): SystemReportFilter {
    return {
      ...this.systemReportTerminalFilter(now),
      $and: [
        {
          $or: [
            { retentionAttempts: { $lt: SYSTEM_REPORT_MAX_ATTEMPTS } },
            { retentionAttempts: { $exists: false } },
          ],
        },
        {
          $or: [
            { retentionCleanupStatus: RetentionCleanupStatus.PENDING },
            { retentionCleanupStatus: { $exists: false } },
            {
              retentionCleanupStatus: RetentionCleanupStatus.FAILED,
              retentionLockedUntil: { $lte: now },
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.FAILED,
              retentionLockedUntil: null,
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
              retentionLockedUntil: { $lte: now },
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
              retentionLockedUntil: null,
            },
          ],
        },
      ],
    };
  }

  private exhaustedSystemReportFilter(now: Date): SystemReportFilter {
    return {
      ...this.systemReportTerminalFilter(now),
      retentionAttempts: { $gte: SYSTEM_REPORT_MAX_ATTEMPTS },
      $or: [
        { retentionCleanupStatus: RetentionCleanupStatus.FAILED },
        {
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockedUntil: { $lte: now },
        },
        {
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockedUntil: null,
        },
        {
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockedUntil: { $exists: false },
        },
      ],
    };
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
  ): void {
    if (mode === 'test-marker' && process.env.NODE_ENV === 'production') {
      throw new Error('Không được cleanup test marker trong production');
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
    field: 'processed' | 'updated' | 'deleted' | 'failed' | 'lostOwnership',
  ): number {
    return results.reduce((total, result) => total + result[field], 0);
  }

  private logSummary(result: DataRetentionResult, lostOwnership: number): void {
    const summary = [
      'Retention cleanup completed',
      `mode=${result.mode}`,
      `execute=${result.execute}`,
      `database=${result.database}`,
      `processed=${result.processed}`,
      `updated=${result.updated}`,
      `deleted=${result.deleted}`,
      `failed=${result.failed}`,
      `lostOwnership=${lostOwnership}`,
      `hasMore=${result.hasMore}`,
    ].join(' ');

    if (result.failed > 0) this.logger.error(summary);
    else if (result.hasMore) this.logger.warn(summary);
    else this.logger.log(summary);
  }
}
