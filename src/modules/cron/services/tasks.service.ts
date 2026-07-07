import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

  constructor(
    private readonly expiredPostCleanupService: ExpiredPostCleanupService,
    private readonly streakService: StreakService,
    private readonly weeklyRecapJobService: WeeklyRecapJobService,
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
      await this.weeklyRecapJobService.runForPreviousCompletedWeek();
    } catch (error) {
      this.logger.error(
        'Weekly recap job crashed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isWeeklyRecapRunning = false;
    }
  }
}
