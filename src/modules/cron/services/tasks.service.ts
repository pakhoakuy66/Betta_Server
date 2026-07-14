import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ReactionCleanupService } from '../../reactions/services/reaction-cleanup.service';
import { ExpiredPostCleanupService } from './expired-post-cleanup.service';
import { StreakService } from '../../streak/services/streak.service';
import { WeeklyRecapJobService } from '../../recap/services/weekly-recap-job.service';
import { RECAP_TIMEZONE } from '../../recap/utils/recap-week.util';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  private isExpiredPostCleanupRunning = false;
  private isStreakDecayRunning = false;
  private isWeeklyRecapRunning = false;
  private isReactionCleanupRunning = false;

  constructor(
    private readonly expiredPostCleanupService: ExpiredPostCleanupService,
    private readonly streakService: StreakService,
    private readonly weeklyRecapJobService: WeeklyRecapJobService,
    private readonly reactionCleanupService: ReactionCleanupService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiredPostCleanup(): Promise<void> {
    if (this.isExpiredPostCleanupRunning) {
      return;
    }

    this.isExpiredPostCleanupRunning = true;

    try {
      await this.expiredPostCleanupService.cleanupExpiredPosts();
    } catch (error) {
      this.logger.error(
        'Expired post cleanup job crashed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isExpiredPostCleanupRunning = false;
    }
  }

  @Cron('10 0 * * *', {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailyStreakDecay(): Promise<void> {
    if (this.isStreakDecayRunning) {
      return;
    }

    this.isStreakDecayRunning = true;

    try {
      await this.streakService.decayUsersWithoutPostForPreviousDay();
    } catch (error) {
      this.logger.error(
        'Daily streak decay job crashed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isStreakDecayRunning = false;
    }
  }

  @Cron('35 0 * * *', {
    timeZone: RECAP_TIMEZONE,
  })
  async handleWeeklyRecapCatchUp(): Promise<void> {
    if (this.isWeeklyRecapRunning) {
      return;
    }

    this.isWeeklyRecapRunning = true;

    try {
      const result =
        await this.weeklyRecapJobService.runCatchUpForCompletedWeeks({
          maxWeeks: 2,
        });

      const summary = [
        'Weekly recap scheduled catch-up finished.',
        `attempted=${result.attemptedWeeks}`,
        `completed=${result.completedWeeks}`,
        `skipped=${result.skippedWeeks}`,
        `failed=${result.failedWeeks}`,
        `remaining=${result.remainingCandidateWeeks}`,
        `truncated=${result.truncatedByLookback}`,
        `hasMore=${result.hasMore}`,
        `oldestUnresolved=${result.oldestUnresolvedWeekKey ?? 'none'}`,
      ].join(' ');

      if (!result.success || result.failedWeeks > 0) {
        this.logger.error(summary);
        return;
      }

      if (result.truncatedByLookback) {
        this.logger.warn(summary);
        return;
      }

      this.logger.log(summary);
    } catch (error) {
      this.logger.error(
        'Weekly recap scheduled catch-up threw an error',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isWeeklyRecapRunning = false;
    }
  }

  @Cron('5 1 * * *', {
    timeZone: RECAP_TIMEZONE,
  })
  async handleReactionCleanup(): Promise<void> {
    const enabled =
      this.configService.get<string>('ENABLE_REACTION_CLEANUP_CRON') === 'true';

    if (!enabled || this.isReactionCleanupRunning) {
      return;
    }

    this.isReactionCleanupRunning = true;

    try {
      await this.reactionCleanupService.cleanupEligibleReactions({
        execute: true,
        batchSize: 500,
        maxWeeks: 20,
        productionConfirmation: this.configService.get<string>(
          'REACTION_CLEANUP_PRODUCTION_CONFIRMATION',
        ),
      });
    } catch (error) {
      this.logger.error(
        'Scheduled reaction cleanup crashed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isReactionCleanupRunning = false;
    }
  }
}
