import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { EngagementEvent } from '../schemas/engagement-event.schema';
import {
  WeeklyRecapRun,
  WeeklyRecapRunStatus,
} from '../schemas/weekly-recap-run.schema';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { RecapService } from './recap.service';
import {
  WeeklyRecapJobService,
  type WeeklyRecapJobResult,
} from './weekly-recap-job.service';

type RunState = {
  weekKey: string;
  weekStart: Date;
  status: WeeklyRecapRunStatus;
  lockedUntil?: Date | null;
  notificationsCreatedAt?: Date | null;
};

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  sort: Mock<(sort: Record<string, number>) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type EventWeek = {
  weekStart: Date;
};

const REFERENCE_DATE = new Date('2026-07-15T05:00:00.000Z');
const W01 = new Date('2026-06-21T17:00:00.000Z');
const W02 = new Date('2026-06-28T17:00:00.000Z');
const W03 = new Date('2026-07-05T17:00:00.000Z');

const weekKey = (weekStart: Date): string => {
  const localDate = new Date(weekStart.getTime() + 7 * 60 * 60 * 1000);

  return [
    localDate.getUTCFullYear(),
    String(localDate.getUTCMonth() + 1).padStart(2, '0'),
    String(localDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
};

const completedResult = (weekStart: Date): WeeklyRecapJobResult => ({
  success: true,
  skipped: false,
  weekKey: weekKey(weekStart),
  status: WeeklyRecapRunStatus.COMPLETED,
  data: {
    weekStart,
    weekEnd: new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000),
    timezone: 'Asia/Ho_Chi_Minh',
    processed: 1,
    upserted: 1,
    modified: 0,
    matched: 0,
  },
});

const failedResult = (weekStart: Date): WeeklyRecapJobResult => ({
  success: true,
  skipped: false,
  weekKey: weekKey(weekStart),
  status: WeeklyRecapRunStatus.FAILED,
});

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn<() => Promise<T>>(() => Promise.resolve(value));

  return query;
};

const createAggregateResult = (value: EventWeek[]) => ({
  exec: jest.fn<() => Promise<EventWeek[]>>(() => Promise.resolve(value)),
});

const createService = ({
  rangeEventWeeks = [],
  initialRuns = [],
  refreshedRuns = initialRuns,
  oldestRunBefore = null,
  oldestEventWithoutRun = null,
  refreshedOldestRunBefore = oldestRunBefore,
  refreshedOldestEventWithoutRun = oldestEventWithoutRun,
}: {
  rangeEventWeeks?: Date[];
  initialRuns?: RunState[];
  refreshedRuns?: RunState[];
  oldestRunBefore?: Date | null;
  oldestEventWithoutRun?: Date | null;
  refreshedOldestRunBefore?: Date | null;
  refreshedOldestEventWithoutRun?: Date | null;
} = {}) => {
  const findResults = [initialRuns, refreshedRuns];
  const findOneResults = [oldestRunBefore, refreshedOldestRunBefore];
  let historicalAggregateCall = 0;

  const weeklyRecapRunModel = {
    find: jest.fn(() => createQuery(findResults.shift() ?? [])),
    findOne: jest.fn(() => {
      const value = findOneResults.shift() ?? null;
      return createQuery(value ? { weekStart: value } : null);
    }),
    collection: {
      collectionName: 'weekly_recap_runs',
    },
  };

  const engagementEventModel = {
    aggregate: jest.fn((pipeline: Array<Record<string, unknown>>) => {
      const match = pipeline[0]?.$match as
        | { weekStart?: { $gte?: Date } }
        | undefined;

      if (match?.weekStart?.$gte) {
        return createAggregateResult(
          rangeEventWeeks.map((weekStart) => ({ weekStart })),
        );
      }

      const value =
        historicalAggregateCall === 0
          ? oldestEventWithoutRun
          : refreshedOldestEventWithoutRun;
      historicalAggregateCall += 1;

      return createAggregateResult(value ? [{ weekStart: value }] : []);
    }),
  };

  const service = new WeeklyRecapJobService(
    {} as RecapService,
    {} as NotificationsService,
    weeklyRecapRunModel as unknown as Model<WeeklyRecapRun>,
    engagementEventModel as unknown as Model<EngagementEvent>,
  );

  return {
    service,
    weeklyRecapRunModel,
    engagementEventModel,
  };
};

describe('WeeklyRecapJobService catch-up', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty successful batch when no backlog exists', async () => {
    const { service } = createService();
    const runForWeek = jest.spyOn(service, 'runForWeek');

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(runForWeek).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      candidateWeeks: 0,
      attemptedWeeks: 0,
      hasMore: false,
      truncatedByLookback: false,
      oldestUnresolvedWeekKey: null,
      fromWeekKey: null,
      throughWeekKey: null,
    });
  });

  it('processes one missing week and reports the attempted range', async () => {
    const completedRun: RunState = {
      weekKey: weekKey(W03),
      weekStart: W03,
      status: WeeklyRecapRunStatus.COMPLETED,
      notificationsCreatedAt: new Date(),
    };
    const { service } = createService({
      rangeEventWeeks: [W03],
      refreshedRuns: [completedRun],
    });
    jest.spyOn(service, 'runForWeek').mockResolvedValue(completedResult(W03));

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(result).toMatchObject({
      success: true,
      candidateWeeks: 1,
      attemptedWeeks: 1,
      completedWeeks: 1,
      remainingCandidateWeeks: 0,
      hasMore: false,
      fromWeekKey: weekKey(W03),
      throughWeekKey: weekKey(W03),
    });
  });

  it('processes oldest weeks first and respects maxWeeks', async () => {
    const refreshedRuns: RunState[] = [W01, W02].map((weekStart) => ({
      weekKey: weekKey(weekStart),
      weekStart,
      status: WeeklyRecapRunStatus.COMPLETED,
      notificationsCreatedAt: new Date(),
    }));
    const { service } = createService({
      rangeEventWeeks: [W03, W01, W02],
      refreshedRuns,
    });
    const runForWeek = jest
      .spyOn(service, 'runForWeek')
      .mockImplementation((weekStart) =>
        Promise.resolve(completedResult(weekStart)),
      );

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
      maxWeeks: 2,
    });

    expect(runForWeek.mock.calls.map(([date]) => date)).toEqual([W01, W02]);
    expect(result).toMatchObject({
      attemptedWeeks: 2,
      completedWeeks: 2,
      remainingCandidateWeeks: 1,
      hasMore: true,
      fromWeekKey: weekKey(W01),
      throughWeekKey: weekKey(W02),
      oldestUnresolvedWeekKey: weekKey(W03),
    });
  });

  it.each([WeeklyRecapRunStatus.PENDING, WeeklyRecapRunStatus.FAILED])(
    'retries a %s run',
    async (status) => {
      const initialRun: RunState = {
        weekKey: weekKey(W03),
        weekStart: W03,
        status,
      };
      const refreshedRun: RunState = {
        ...initialRun,
        status: WeeklyRecapRunStatus.COMPLETED,
        notificationsCreatedAt: new Date(),
      };
      const { service } = createService({
        initialRuns: [initialRun],
        refreshedRuns: [refreshedRun],
      });
      const runForWeek = jest
        .spyOn(service, 'runForWeek')
        .mockResolvedValue(completedResult(W03));

      const result = await service.runCatchUpForCompletedWeeks({
        referenceDate: REFERENCE_DATE,
      });

      expect(runForWeek).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    },
  );

  it('retries stale and missing locks but skips a fresh running lock', async () => {
    const staleRun: RunState = {
      weekKey: weekKey(W01),
      weekStart: W01,
      status: WeeklyRecapRunStatus.RUNNING,
      lockedUntil: new Date('2026-01-01T00:00:00.000Z'),
    };
    const missingLockRun: RunState = {
      weekKey: weekKey(W02),
      weekStart: W02,
      status: WeeklyRecapRunStatus.RUNNING,
    };
    const freshRun: RunState = {
      weekKey: weekKey(W03),
      weekStart: W03,
      status: WeeklyRecapRunStatus.RUNNING,
      lockedUntil: new Date('2099-01-01T00:00:00.000Z'),
    };
    const refreshedRuns: RunState[] = [staleRun, missingLockRun].map((run) => ({
      ...run,
      status: WeeklyRecapRunStatus.COMPLETED,
      notificationsCreatedAt: new Date(),
    }));
    refreshedRuns.push(freshRun);
    const { service } = createService({
      initialRuns: [staleRun, missingLockRun, freshRun],
      refreshedRuns,
    });
    const runForWeek = jest
      .spyOn(service, 'runForWeek')
      .mockImplementation((weekStart) =>
        Promise.resolve(completedResult(weekStart)),
      );

    await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
      maxWeeks: 3,
    });

    expect(runForWeek.mock.calls.map(([date]) => date)).toEqual([W01, W02]);
  });

  it('reconciles completed runs with a null or missing notification marker', async () => {
    const initialRuns: RunState[] = [W02, W03].map((weekStart) => ({
      weekKey: weekKey(weekStart),
      weekStart,
      status: WeeklyRecapRunStatus.COMPLETED,
    }));
    initialRuns[0].notificationsCreatedAt = null;
    const refreshedRuns = initialRuns.map((run) => ({
      ...run,
      notificationsCreatedAt: new Date(),
    }));
    const { service } = createService({ initialRuns, refreshedRuns });
    const runForWeek = jest
      .spyOn(service, 'runForWeek')
      .mockImplementation((weekStart) =>
        Promise.resolve({
          ...completedResult(weekStart),
          skipped: true,
        }),
      );

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(runForWeek).toHaveBeenCalledTimes(2);
    expect(result.skippedWeeks).toBe(2);
    expect(result.remainingCandidateWeeks).toBe(0);
  });

  it('stops when runForWeek throws and counts attempts exactly', async () => {
    const refreshedRuns: RunState[] = [
      {
        weekKey: weekKey(W01),
        weekStart: W01,
        status: WeeklyRecapRunStatus.COMPLETED,
        notificationsCreatedAt: new Date(),
      },
      {
        weekKey: weekKey(W02),
        weekStart: W02,
        status: WeeklyRecapRunStatus.FAILED,
      },
    ];
    const { service } = createService({
      rangeEventWeeks: [W01, W02, W03],
      refreshedRuns,
    });
    const runForWeek = jest
      .spyOn(service, 'runForWeek')
      .mockResolvedValueOnce(completedResult(W01))
      .mockRejectedValueOnce(new Error('aggregate failed'));

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
      maxWeeks: 3,
    });

    expect(runForWeek).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: false,
      attemptedWeeks: 2,
      failedWeeks: 1,
      failedWeekKey: weekKey(W02),
      fromWeekKey: weekKey(W01),
      throughWeekKey: weekKey(W02),
    });
  });

  it('stops on a FAILED result without counting the attempt twice', async () => {
    const failedRun: RunState = {
      weekKey: weekKey(W02),
      weekStart: W02,
      status: WeeklyRecapRunStatus.FAILED,
    };
    const { service } = createService({
      rangeEventWeeks: [W01, W02, W03],
      refreshedRuns: [
        {
          weekKey: weekKey(W01),
          weekStart: W01,
          status: WeeklyRecapRunStatus.COMPLETED,
          notificationsCreatedAt: new Date(),
        },
        failedRun,
      ],
    });
    jest
      .spyOn(service, 'runForWeek')
      .mockResolvedValueOnce(completedResult(W01))
      .mockResolvedValueOnce(failedResult(W02));

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
      maxWeeks: 3,
    });

    expect(result).toMatchObject({
      success: false,
      attemptedWeeks: 2,
      failedWeeks: 1,
      failedWeekKey: weekKey(W02),
      throughWeekKey: weekKey(W02),
    });
  });

  it('keeps a failed attempt as oldest unresolved when markFailed leaves a fresh lock', async () => {
    const freshFailedRun: RunState = {
      weekKey: weekKey(W02),
      weekStart: W02,
      status: WeeklyRecapRunStatus.RUNNING,
      lockedUntil: new Date('2099-01-01T00:00:00.000Z'),
    };
    const { service } = createService({
      rangeEventWeeks: [W02, W03],
      refreshedRuns: [freshFailedRun],
    });
    jest
      .spyOn(service, 'runForWeek')
      .mockRejectedValueOnce(new Error('markFailed also failed'));

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(result.oldestUnresolvedWeekKey).toBe(weekKey(W02));
  });

  it('does not retain a failed week when another worker completed it before refresh', async () => {
    const completedByWorker: RunState = {
      weekKey: weekKey(W02),
      weekStart: W02,
      status: WeeklyRecapRunStatus.COMPLETED,
      notificationsCreatedAt: new Date(),
    };
    const { service } = createService({
      rangeEventWeeks: [W02, W03],
      refreshedRuns: [completedByWorker],
    });
    jest
      .spyOn(service, 'runForWeek')
      .mockRejectedValueOnce(new Error('worker race'));

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(result.oldestUnresolvedWeekKey).toBe(weekKey(W03));
  });

  it('reports backlog outside lookback but ignores a resolved historical range', async () => {
    const outside = new Date('2024-01-07T17:00:00.000Z');
    const truncated = createService({
      oldestRunBefore: outside,
      refreshedOldestRunBefore: outside,
    });
    const clean = createService();

    const truncatedResult = await truncated.service.runCatchUpForCompletedWeeks(
      {
        referenceDate: REFERENCE_DATE,
      },
    );
    const cleanResult = await clean.service.runCatchUpForCompletedWeeks({
      referenceDate: REFERENCE_DATE,
    });

    expect(truncatedResult).toMatchObject({
      truncatedByLookback: true,
      hasMore: true,
      oldestUnresolvedWeekKey: weekKey(outside),
    });
    expect(cleanResult).toMatchObject({
      truncatedByLookback: false,
      oldestUnresolvedWeekKey: null,
    });
  });

  it('rejects invalid options before querying MongoDB', async () => {
    const { service, weeklyRecapRunModel } = createService();

    await expect(
      service.runCatchUpForCompletedWeeks({ maxWeeks: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.runCatchUpForCompletedWeeks({ lookbackWeeks: 261 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.runCatchUpForCompletedWeeks({
        referenceDate: new Date('invalid'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(weeklyRecapRunModel.find).not.toHaveBeenCalled();
  });
});
