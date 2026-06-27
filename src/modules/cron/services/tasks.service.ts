import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExpiredPostCleanupService } from './expired-post-cleanup.service';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  private isExpiredPostCleanupRunning = false;

  constructor(
    private readonly expiredPostCleanupService: ExpiredPostCleanupService,
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
}
