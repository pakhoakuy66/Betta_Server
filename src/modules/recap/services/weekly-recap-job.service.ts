import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WeeklyRecapRun,
  WeeklyRecapRunStatus,
} from '../schemas/weekly-recap-run.schema';
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

@Injectable()
export class WeeklyRecapJobService {
  private readonly logger = new Logger(WeeklyRecapJobService.name);

  constructor(
    private readonly recapService: RecapService,
    private readonly notificationsService: NotificationsService,

    @InjectModel(WeeklyRecapRun.name)
    private readonly weeklyRecapRunModel: Model<WeeklyRecapRun>,
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
}
