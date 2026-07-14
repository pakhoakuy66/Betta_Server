import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WeeklyRecapRun,
  WeeklyRecapRunStatus,
} from '../schemas/weekly-recap-run.schema';
import { EngagementEvent } from '../schemas/engagement-event.schema';
import { RecapService, type AggregateWeeklyRecapResult } from './recap.service';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  getRecapWeekIdentity,
  getRecapWeekRange,
  RECAP_TIMEZONE,
} from '../utils/recap-week.util';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_RECAP_LOCK_MS = 30 * 60 * 1000;
const MAX_LAST_ERROR_LENGTH = 1000;

const DEFAULT_CATCH_UP_MAX_WEEKS = 2;
const MAX_CATCH_UP_WEEKS_PER_RUN = 52;

const DEFAULT_CATCH_UP_LOOKBACK_WEEKS = 52;
const MAX_CATCH_UP_LOOKBACK_WEEKS = 260;

const FUTURE_REFERENCE_TOLERANCE_MS = 60_000;

type MongoDuplicateKeyError = {
  code?: number;
};

type RunWeeklyRecapOptions = {
  force?: boolean;
};

export type WeeklyRecapJobResult = {
  success: true;
  skipped: boolean;
  weekKey: string;
  status: WeeklyRecapRunStatus;
  data?: AggregateWeeklyRecapResult['data'];
  message?: string;
};

export type WeeklyRecapCatchUpOptions = {
  referenceDate?: Date;
  maxWeeks?: number;
  lookbackWeeks?: number;
};

export type WeeklyRecapCatchUpResult = {
  success: boolean;
  scannedWeeks: number;
  candidateWeeks: number;
  attemptedWeeks: number;
  completedWeeks: number;
  skippedWeeks: number;
  failedWeeks: number;
  failedWeekKey: string | null;
  remainingCandidateWeeks: number;
  hasMore: boolean;
  truncatedByLookback: boolean;
  oldestUnresolvedWeekKey: string | null;
  fromWeekKey: string | null;
  throughWeekKey: string | null;
  results: WeeklyRecapJobResult[];
};

type CatchUpRunState = {
  weekKey: string;
  weekStart: Date;
  status: WeeklyRecapRunStatus;
  lockedUntil?: Date | null;
  notificationsCreatedAt?: Date | null;
};

type CatchUpWeek = {
  weekKey: string;
  weekStart: Date;
};

type EventWeekResult = {
  weekStart: Date;
};

@Injectable()
export class WeeklyRecapJobService {
  private readonly logger = new Logger(WeeklyRecapJobService.name);

  constructor(
    private readonly recapService: RecapService,
    private readonly notificationsService: NotificationsService,

    @InjectModel(WeeklyRecapRun.name)
    private readonly weeklyRecapRunModel: Model<WeeklyRecapRun>,

    @InjectModel(EngagementEvent.name)
    private readonly engagementEventModel: Model<EngagementEvent>,
  ) {}

  async runForPreviousCompletedWeek(
    referenceDate = new Date(),
    options: RunWeeklyRecapOptions = {},
  ): Promise<WeeklyRecapJobResult> {
    const currentWeek = getRecapWeekRange(referenceDate);
    const previousWeekStart = new Date(
      currentWeek.weekStart.getTime() - ONE_WEEK_MS,
    );

    return this.runForWeek(previousWeekStart, options);
  }

  async runForWeek(
    weekStart: Date,
    options: RunWeeklyRecapOptions = {},
  ): Promise<WeeklyRecapJobResult> {
    const weekEnd = new Date(weekStart.getTime() + ONE_WEEK_MS);
    const weekIdentity = getRecapWeekIdentity(weekStart);

    await this.ensureRunDocument({
      weekStart,
      weekEnd,
      year: weekIdentity.year,
      weekNumber: weekIdentity.weekNumber,
      weekKey: weekIdentity.weekKey,
    });

    const claimedRun = await this.claimRun(weekIdentity.weekKey, options);

    if (!claimedRun) {
      const currentRun = await this.weeklyRecapRunModel
        .findOne({
          weekKey: weekIdentity.weekKey,
          timezone: RECAP_TIMEZONE,
        })
        .select('status notificationsCreatedAt')
        .lean<{
          status: WeeklyRecapRunStatus;
          notificationsCreatedAt: Date | null;
        }>()
        .exec();

      if (
        currentRun?.status === WeeklyRecapRunStatus.COMPLETED &&
        !currentRun.notificationsCreatedAt
      ) {
        await this.createRecapReadyNotifications(weekIdentity.weekKey);
      }

      return {
        success: true,
        skipped: true,
        weekKey: weekIdentity.weekKey,
        status: currentRun?.status ?? WeeklyRecapRunStatus.RUNNING,
        message: 'Weekly recap run is already completed or currently running',
      };
    }

    try {
      const result = await this.recapService.aggregateWeeklyRecap({
        weekStart,
      });

      await this.markCompleted(weekIdentity.weekKey, result.data);
      await this.createRecapReadyNotifications(weekIdentity.weekKey);

      this.logger.log(
        `Weekly recap job completed. week=${weekIdentity.weekKey}, processed=${result.data.processed}, upserted=${result.data.upserted}, modified=${result.data.modified}`,
      );

      return {
        success: true,
        skipped: false,
        weekKey: weekIdentity.weekKey,
        status: WeeklyRecapRunStatus.COMPLETED,
        data: result.data,
      };
    } catch (error) {
      await this.markFailed(weekIdentity.weekKey, error);
      throw error;
    }
  }

  private async ensureRunDocument({
    weekStart,
    weekEnd,
    year,
    weekNumber,
    weekKey,
  }: {
    weekStart: Date;
    weekEnd: Date;
    year: number;
    weekNumber: number;
    weekKey: string;
  }): Promise<void> {
    try {
      await this.weeklyRecapRunModel
        .updateOne(
          { weekKey, timezone: RECAP_TIMEZONE },
          {
            $setOnInsert: {
              year,
              weekNumber,
              weekKey,
              weekStart,
              weekEnd,
              timezone: RECAP_TIMEZONE,
              status: WeeklyRecapRunStatus.PENDING,
              startedAt: null,
              completedAt: null,
              lockedUntil: null,
              attemptCount: 0,
              processed: 0,
              upserted: 0,
              modified: 0,
              matched: 0,
              lastError: '',
              notificationsCreatedAt: null,
              notificationsAttemptedCount: 0,
              notificationsCreatedCount: 0,
              notificationsMatchedCount: 0,
              notificationLastError: '',
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) return;
      throw error;
    }
  }

  private async claimRun(
    weekKey: string,
    { force = false }: RunWeeklyRecapOptions,
  ): Promise<WeeklyRecapRun | null> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + WEEKLY_RECAP_LOCK_MS);

    const claimableStatuses = force
      ? [
          WeeklyRecapRunStatus.PENDING,
          WeeklyRecapRunStatus.FAILED,
          WeeklyRecapRunStatus.COMPLETED,
        ]
      : [WeeklyRecapRunStatus.PENDING, WeeklyRecapRunStatus.FAILED];

    return this.weeklyRecapRunModel
      .findOneAndUpdate(
        {
          weekKey,
          timezone: RECAP_TIMEZONE,
          $or: [
            { status: { $in: claimableStatuses } },
            {
              status: WeeklyRecapRunStatus.RUNNING,
              lockedUntil: { $lte: now },
            },
            {
              status: WeeklyRecapRunStatus.RUNNING,
              lockedUntil: null,
            },
          ],
        },
        {
          $set: {
            status: WeeklyRecapRunStatus.RUNNING,
            startedAt: now,
            completedAt: null,
            lockedUntil,
            lastError: '',
          },
          $inc: {
            attemptCount: 1,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  private async markCompleted(
    weekKey: string,
    data: AggregateWeeklyRecapResult['data'],
  ): Promise<void> {
    await this.weeklyRecapRunModel
      .updateOne(
        {
          weekKey,
          timezone: RECAP_TIMEZONE,
          status: WeeklyRecapRunStatus.RUNNING,
        },
        {
          $set: {
            status: WeeklyRecapRunStatus.COMPLETED,
            completedAt: new Date(),
            lockedUntil: null,
            processed: data.processed,
            upserted: data.upserted,
            modified: data.modified,
            matched: data.matched,
            lastError: '',
          },
        },
      )
      .exec();
  }

  private async markFailed(weekKey: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    await this.weeklyRecapRunModel
      .updateOne(
        {
          weekKey,
          timezone: RECAP_TIMEZONE,
          status: WeeklyRecapRunStatus.RUNNING,
        },
        {
          $set: {
            status: WeeklyRecapRunStatus.FAILED,
            completedAt: null,
            lockedUntil: null,
            lastError: message.slice(0, MAX_LAST_ERROR_LENGTH),
          },
        },
      )
      .exec();
  }

  private isDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  private async createRecapReadyNotifications(weekKey: string): Promise<void> {
    try {
      const targets =
        await this.recapService.getWeeklyRecapNotificationTargets(weekKey);

      const result =
        await this.notificationsService.createRecapReadyNotifications({
          targets,
        });

      await this.weeklyRecapRunModel
        .updateOne(
          {
            weekKey,
            timezone: RECAP_TIMEZONE,
          },
          {
            $set: {
              notificationsCreatedAt: new Date(),
              notificationsAttemptedCount: result.attempted,
              notificationsCreatedCount: result.created,
              notificationsMatchedCount: result.matched,
              notificationLastError: '',
            },
          },
        )
        .exec();

      this.logger.log(
        `Weekly recap notifications processed. week=${weekKey}, attempted=${result.attempted}, created=${result.created}, matched=${result.matched}, modified=${result.modified}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.weeklyRecapRunModel
        .updateOne(
          {
            weekKey,
            timezone: RECAP_TIMEZONE,
          },
          {
            $set: {
              notificationLastError: message.slice(0, MAX_LAST_ERROR_LENGTH),
            },
          },
        )
        .exec();

      this.logger.warn(
        `Weekly recap notifications failed. week=${weekKey}`,
        error instanceof Error ? error.stack : message,
      );
    }
  }

  private validateReferenceDate(referenceDate: Date): void {
    if (Number.isNaN(referenceDate.getTime())) {
      throw new BadRequestException('Ngày tham chiếu không hợp lệ');
    }

    const isFutureReference =
      referenceDate.getTime() > Date.now() + FUTURE_REFERENCE_TOLERANCE_MS;

    if (process.env.NODE_ENV === 'production' && isFutureReference) {
      throw new BadRequestException(
        'Không được dùng ngày tham chiếu trong tương lai ở production',
      );
    }
  }

  private validatePositiveIntegerOption(
    value: number,
    optionName: string,
    maximum: number,
  ): void {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new BadRequestException(
        `${optionName} phải là số nguyên từ 1 đến ${maximum}`,
      );
    }
  }

  private isCatchUpCandidate(
    run: CatchUpRunState | undefined,
    now: Date,
  ): boolean {
    if (!run) {
      return true;
    }

    if (
      run.status === WeeklyRecapRunStatus.PENDING ||
      run.status === WeeklyRecapRunStatus.FAILED
    ) {
      return true;
    }

    if (run.status === WeeklyRecapRunStatus.RUNNING) {
      return !run.lockedUntil || run.lockedUntil.getTime() <= now.getTime();
    }

    return (
      run.status === WeeklyRecapRunStatus.COMPLETED &&
      !run.notificationsCreatedAt
    );
  }

  private async findOldestUnresolvedWeekBefore(
    before: Date,
    now: Date,
  ): Promise<Date | null> {
    const [actionableRun, eventWithoutRun] = await Promise.all([
      this.weeklyRecapRunModel
        .findOne({
          timezone: RECAP_TIMEZONE,
          weekStart: {
            $lt: before,
          },
          $or: [
            {
              status: WeeklyRecapRunStatus.PENDING,
            },
            {
              status: WeeklyRecapRunStatus.FAILED,
            },
            {
              status: WeeklyRecapRunStatus.RUNNING,
              $or: [
                {
                  lockedUntil: {
                    $lte: now,
                  },
                },
                {
                  lockedUntil: null,
                },
              ],
            },
            {
              status: WeeklyRecapRunStatus.COMPLETED,
              notificationsCreatedAt: null,
            },
          ],
        })
        .sort({
          weekStart: 1,
        })
        .select('weekStart')
        .lean<{ weekStart: Date }>()
        .exec(),

      this.engagementEventModel
        .aggregate<EventWeekResult>([
          {
            $match: {
              timezone: RECAP_TIMEZONE,
              weekStart: {
                $lt: before,
              },
            },
          },
          {
            $group: {
              _id: '$weekStart',
            },
          },
          {
            $lookup: {
              from: this.weeklyRecapRunModel.collection.collectionName,
              let: {
                eventWeekStart: '$_id',
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        {
                          $eq: ['$timezone', RECAP_TIMEZONE],
                        },
                        {
                          $eq: ['$weekStart', '$$eventWeekStart'],
                        },
                      ],
                    },
                  },
                },
                {
                  $limit: 1,
                },
              ],
              as: 'runs',
            },
          },
          {
            $match: {
              runs: {
                $size: 0,
              },
            },
          },
          {
            $sort: {
              _id: 1,
            },
          },
          {
            $limit: 1,
          },
          {
            $project: {
              _id: 0,
              weekStart: '$_id',
            },
          },
        ])
        .exec(),
    ]);

    const actionableRunWeekStart = actionableRun?.weekStart ?? null;

    const eventWeekStart = eventWithoutRun[0]?.weekStart ?? null;

    if (!actionableRunWeekStart) {
      return eventWeekStart;
    }

    if (!eventWeekStart) {
      return actionableRunWeekStart;
    }

    return actionableRunWeekStart.getTime() <= eventWeekStart.getTime()
      ? actionableRunWeekStart
      : eventWeekStart;
  }

  async runCatchUpForCompletedWeeks(
    options: WeeklyRecapCatchUpOptions = {},
  ): Promise<WeeklyRecapCatchUpResult> {
    const referenceDate = options.referenceDate ?? new Date();

    const maxWeeks = options.maxWeeks ?? DEFAULT_CATCH_UP_MAX_WEEKS;

    const lookbackWeeks =
      options.lookbackWeeks ?? DEFAULT_CATCH_UP_LOOKBACK_WEEKS;

    this.validateReferenceDate(referenceDate);

    this.validatePositiveIntegerOption(
      maxWeeks,
      'maxWeeks',
      MAX_CATCH_UP_WEEKS_PER_RUN,
    );

    this.validatePositiveIntegerOption(
      lookbackWeeks,
      'lookbackWeeks',
      MAX_CATCH_UP_LOOKBACK_WEEKS,
    );

    const currentWeek = getRecapWeekRange(referenceDate);

    const latestCompletedWeekStart = new Date(
      currentWeek.weekStart.getTime() - ONE_WEEK_MS,
    );

    const latestCompletedWeekEndExclusive = new Date(
      latestCompletedWeekStart.getTime() + ONE_WEEK_MS,
    );

    const lookbackStart = new Date(
      latestCompletedWeekStart.getTime() - (lookbackWeeks - 1) * ONE_WEEK_MS,
    );

    const discoveryTime = new Date();

    const [eventWeeks, existingRuns, initialOldestOutsideLookback] =
      await Promise.all([
        this.engagementEventModel
          .aggregate<EventWeekResult>([
            {
              $match: {
                timezone: RECAP_TIMEZONE,
                weekStart: {
                  $gte: lookbackStart,
                  $lt: latestCompletedWeekEndExclusive,
                },
              },
            },
            {
              $group: {
                _id: '$weekStart',
              },
            },
            {
              $sort: {
                _id: 1,
              },
            },
            {
              $project: {
                _id: 0,
                weekStart: '$_id',
              },
            },
          ])
          .exec(),

        this.weeklyRecapRunModel
          .find({
            timezone: RECAP_TIMEZONE,
            weekStart: {
              $gte: lookbackStart,
              $lt: latestCompletedWeekEndExclusive,
            },
          })
          .select('weekKey weekStart status lockedUntil notificationsCreatedAt')
          .sort({
            weekStart: 1,
          })
          .lean<CatchUpRunState[]>()
          .exec(),

        this.findOldestUnresolvedWeekBefore(lookbackStart, discoveryTime),
      ]);

    const existingRunByWeekKey = new Map(
      existingRuns.map((run) => [run.weekKey, run]),
    );

    const relevantWeekStartByKey = new Map<string, Date>();

    for (const eventWeek of eventWeeks) {
      const week = getRecapWeekRange(eventWeek.weekStart);

      const identity = getRecapWeekIdentity(week.weekStart);

      relevantWeekStartByKey.set(identity.weekKey, week.weekStart);
    }

    for (const run of existingRuns) {
      relevantWeekStartByKey.set(run.weekKey, run.weekStart);
    }

    const relevantWeeks: CatchUpWeek[] = [...relevantWeekStartByKey.entries()]
      .map(([weekKey, weekStart]) => ({
        weekKey,
        weekStart,
      }))
      .sort(
        (left, right) => left.weekStart.getTime() - right.weekStart.getTime(),
      );

    const candidateWeeks = relevantWeeks.filter(({ weekKey }) =>
      this.isCatchUpCandidate(existingRunByWeekKey.get(weekKey), discoveryTime),
    );

    const selectedCandidates = candidateWeeks.slice(0, maxWeeks);

    const actuallyAttemptedCandidates: CatchUpWeek[] = [];

    const results: WeeklyRecapJobResult[] = [];

    let failedWeeks = 0;
    let failedWeekKey: string | null = null;

    for (const candidate of selectedCandidates) {
      actuallyAttemptedCandidates.push(candidate);

      try {
        const result = await this.runForWeek(candidate.weekStart, {
          force: false,
        });

        results.push(result);

        if (result.status === WeeklyRecapRunStatus.FAILED) {
          failedWeeks = 1;
          failedWeekKey = candidate.weekKey;

          this.logger.error(
            `Weekly recap catch-up returned failed status. week=${candidate.weekKey}`,
          );

          break;
        }
      } catch (error) {
        failedWeeks = 1;
        failedWeekKey = candidate.weekKey;

        this.logger.error(
          `Weekly recap catch-up failed. week=${candidate.weekKey}`,
          error instanceof Error ? error.stack : String(error),
        );

        break;
      }
    }

    const attemptedWeeks = actuallyAttemptedCandidates.length;

    const stateAfterBatchTime = new Date();

    const refreshedRuns = await this.weeklyRecapRunModel
      .find({
        timezone: RECAP_TIMEZONE,
        weekStart: {
          $gte: lookbackStart,
          $lt: latestCompletedWeekEndExclusive,
        },
      })
      .select('weekKey weekStart status lockedUntil notificationsCreatedAt')
      .sort({
        weekStart: 1,
      })
      .lean<CatchUpRunState[]>()
      .exec();

    const refreshedRunByWeekKey = new Map(
      refreshedRuns.map((run) => [run.weekKey, run]),
    );

    const remainingCandidates = relevantWeeks.filter(({ weekKey }) =>
      this.isCatchUpCandidate(
        refreshedRunByWeekKey.get(weekKey),
        stateAfterBatchTime,
      ),
    );

    let oldestOutsideLookback = initialOldestOutsideLookback;

    /*
     * Chỉ query lịch sử lần hai nếu lần đầu đã phát
     * hiện backlog ngoài lookback.
     */
    if (initialOldestOutsideLookback !== null) {
      oldestOutsideLookback = await this.findOldestUnresolvedWeekBefore(
        lookbackStart,
        stateAfterBatchTime,
      );
    }

    const truncatedByLookback = oldestOutsideLookback !== null;

    const failedAttemptWeek =
      failedWeeks > 0
        ? (actuallyAttemptedCandidates[
            actuallyAttemptedCandidates.length - 1
          ] ?? null)
        : null;

    const failedRunAfterBatch =
      failedWeekKey !== null
        ? refreshedRunByWeekKey.get(failedWeekKey)
        : undefined;

    /*
     * Nếu runForWeek lỗi và markFailed cũng lỗi,
     * document có thể vẫn là fresh RUNNING.
     */
    const failedAttemptNeedsFallback =
      failedAttemptWeek !== null &&
      failedRunAfterBatch?.status === WeeklyRecapRunStatus.RUNNING &&
      !this.isCatchUpCandidate(failedRunAfterBatch, stateAfterBatchTime);

    const oldestUnresolvedInsideLookback = failedAttemptNeedsFallback
      ? failedAttemptWeek
      : (remainingCandidates[0] ?? null);

    const oldestUnresolvedWeekKey = oldestOutsideLookback
      ? getRecapWeekIdentity(oldestOutsideLookback).weekKey
      : (oldestUnresolvedInsideLookback?.weekKey ?? null);

    const completedWeeks = results.filter(
      (result) =>
        result.status === WeeklyRecapRunStatus.COMPLETED && !result.skipped,
    ).length;

    const skippedWeeks = results.filter((result) => result.skipped).length;

    const hasMore =
      failedWeeks > 0 || remainingCandidates.length > 0 || truncatedByLookback;

    const firstAttemptedWeek = actuallyAttemptedCandidates[0] ?? null;

    const lastAttemptedWeek =
      actuallyAttemptedCandidates[actuallyAttemptedCandidates.length - 1] ??
      null;

    const result: WeeklyRecapCatchUpResult = {
      success: failedWeeks === 0,
      scannedWeeks: relevantWeeks.length,
      candidateWeeks: candidateWeeks.length,
      attemptedWeeks,
      completedWeeks,
      skippedWeeks,
      failedWeeks,
      failedWeekKey,
      remainingCandidateWeeks: remainingCandidates.length,
      hasMore,
      truncatedByLookback,
      oldestUnresolvedWeekKey,
      fromWeekKey: firstAttemptedWeek?.weekKey ?? null,
      throughWeekKey: lastAttemptedWeek?.weekKey ?? null,
      results,
    };

    const summary = [
      'Weekly recap catch-up finished.',
      `scanned=${result.scannedWeeks}`,
      `candidates=${result.candidateWeeks}`,
      `attempted=${result.attemptedWeeks}`,
      `completed=${result.completedWeeks}`,
      `skipped=${result.skippedWeeks}`,
      `failed=${result.failedWeeks}`,
      `remaining=${result.remainingCandidateWeeks}`,
      `truncated=${result.truncatedByLookback}`,
      `oldestUnresolved=${result.oldestUnresolvedWeekKey ?? 'none'}`,
    ].join(' ');

    if (!result.success) {
      this.logger.error(summary);
    } else if (result.truncatedByLookback) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }

    return result;
  }
}
