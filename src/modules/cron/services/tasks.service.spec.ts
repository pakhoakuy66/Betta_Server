import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { ConfigService } from '@nestjs/config';
import { ReactionCleanupService } from '../../reactions/services/reaction-cleanup.service';
import { TasksService } from './tasks.service';
import { ExpiredPostCleanupService } from './expired-post-cleanup.service';
import { StreakService } from '../../streak/services/streak.service';
import {
  WeeklyRecapJobService,
  type WeeklyRecapCatchUpResult,
} from '../../recap/services/weekly-recap-job.service';
import { AdminUserRestrictionExpiryService } from '../../admin/services/admin-user-restriction-expiry.service';

const catchUpResult = (
  overrides: Partial<WeeklyRecapCatchUpResult> = {},
): WeeklyRecapCatchUpResult => ({
  success: true,
  scannedWeeks: 0,
  candidateWeeks: 0,
  attemptedWeeks: 0,
  completedWeeks: 0,
  skippedWeeks: 0,
  failedWeeks: 0,
  failedWeekKey: null,
  remainingCandidateWeeks: 0,
  hasMore: false,
  truncatedByLookback: false,
  oldestUnresolvedWeekKey: null,
  fromWeekKey: null,
  throughWeekKey: null,
  results: [],
  ...overrides,
});

describe('TasksService weekly recap catch-up logging', () => {
  const createService = () => {
    const weeklyRecapJobService = {
      runCatchUpForCompletedWeeks:
        jest.fn<WeeklyRecapJobService['runCatchUpForCompletedWeeks']>(),
    };

    const reactionCleanupService = {
      cleanupEligibleReactions: jest.fn(),
    };

    const restrictionExpiryService = {
      expireDueRestrictions: jest.fn<
        AdminUserRestrictionExpiryService['expireDueRestrictions']
      >(() =>
        Promise.resolve({ scanned: 0, expired: 0, skipped: 0, failed: 0 }),
      ),
    };

    const configService = {
      get: jest.fn(),
    };

    const service = new TasksService(
      {} as ExpiredPostCleanupService,
      {} as StreakService,
      weeklyRecapJobService as unknown as WeeklyRecapJobService,
      reactionCleanupService as unknown as ReactionCleanupService,
      restrictionExpiryService as unknown as AdminUserRestrictionExpiryService,
      configService as unknown as ConfigService,
    );
    const logger = (
      service as unknown as {
        logger: {
          log: Mock<(...args: unknown[]) => void>;
          warn: Mock<(...args: unknown[]) => void>;
          error: Mock<(...args: unknown[]) => void>;
        };
      }
    ).logger;

    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    return { service, weeklyRecapJobService, restrictionExpiryService, logger };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prevents local overlap while allowing the next expiry tick', async () => {
    const { service, restrictionExpiryService } = createService();
    let release: (() => void) | undefined;
    restrictionExpiryService.expireDueRestrictions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ scanned: 1, expired: 1, skipped: 0, failed: 0 });
        }),
    );

    const first = service.handleRestrictionExpiry();
    await Promise.resolve();
    await service.handleRestrictionExpiry();

    expect(
      restrictionExpiryService.expireDueRestrictions,
    ).toHaveBeenCalledTimes(1);

    release?.();
    await first;
    await service.handleRestrictionExpiry();

    expect(
      restrictionExpiryService.expireDueRestrictions,
    ).toHaveBeenCalledTimes(2);
  });

  it('logs failed expiry batches without throwing from the scheduler', async () => {
    const { service, restrictionExpiryService, logger } = createService();
    restrictionExpiryService.expireDueRestrictions.mockResolvedValue({
      scanned: 3,
      expired: 1,
      skipped: 1,
      failed: 1,
    });

    await expect(service.handleRestrictionExpiry()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"failed":1'),
    );
  });

  it('logs successful batches at info level', async () => {
    const { service, weeklyRecapJobService, logger } = createService();
    weeklyRecapJobService.runCatchUpForCompletedWeeks.mockResolvedValue(
      catchUpResult(),
    );

    await service.handleWeeklyRecapCatchUp();

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs truncated batches at warning level', async () => {
    const { service, weeklyRecapJobService, logger } = createService();
    weeklyRecapJobService.runCatchUpForCompletedWeeks.mockResolvedValue(
      catchUpResult({
        truncatedByLookback: true,
        hasMore: true,
        oldestUnresolvedWeekKey: '2024-01-08',
      }),
    );

    await service.handleWeeklyRecapCatchUp();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs failed batches and thrown errors at error level', async () => {
    const first = createService();
    first.weeklyRecapJobService.runCatchUpForCompletedWeeks.mockResolvedValue(
      catchUpResult({ success: false, failedWeeks: 1, hasMore: true }),
    );

    await first.service.handleWeeklyRecapCatchUp();

    expect(first.logger.error).toHaveBeenCalledTimes(1);

    const second = createService();
    second.weeklyRecapJobService.runCatchUpForCompletedWeeks.mockRejectedValue(
      new Error('job crashed'),
    );

    await second.service.handleWeeklyRecapCatchUp();

    expect(second.logger.error).toHaveBeenCalledTimes(1);
  });
});
