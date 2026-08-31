import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Connection } from 'mongoose';
import { DataRetentionService } from './data-retention.service';
import type { ReportEvidenceRetentionService } from './report-evidence-retention.service';
import type { CollectionCleanupResult } from './retention.types';

type PrivateRetentionMethods = {
  result: (
    collection: string,
    eligible: number,
    planned: number,
    startedAt: number,
    values?: Partial<CollectionCleanupResult>,
  ) => CollectionCleanupResult;
};

type RetentionPhase = (
  budget: number,
  execute: boolean,
  now: Date,
) => Promise<CollectionCleanupResult>;

type RetentionWorkerMethod =
  | 'reconcileExhaustedClaims'
  | 'reconcileMissingPostEvidence'
  | 'purgeReportEvidence'
  | 'purgeSystemReportEvidence'
  | 'deleteSafeReportMetadata'
  | 'deleteSafeSystemReportMetadata';

const cleanupResult = (
  collection: string,
  planned = 0,
): CollectionCleanupResult => ({
  collection,
  eligible: planned,
  planned,
  processed: 0,
  updated: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  lostOwnership: 0,
  manualReview: 0,
  truncated: false,
  durationMs: 0,
});

const createRetentionWorker = (
  overrides: Partial<
    Record<RetentionWorkerMethod, jest.MockedFunction<RetentionPhase>>
  > = {},
): ReportEvidenceRetentionService =>
  ({
    reconcileExhaustedClaims: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('manual_review')),
    reconcileMissingPostEvidence: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('reconciliation')),
    purgeReportEvidence: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('reports_evidence')),
    purgeSystemReportEvidence: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('system_reports_evidence')),
    deleteSafeReportMetadata: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('reports_safe_metadata')),
    deleteSafeSystemReportMetadata: jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('system_reports_safe_metadata')),
    ...overrides,
  }) as unknown as ReportEvidenceRetentionService;

const createService = (
  collectionFactory?: () => unknown,
  worker = createRetentionWorker(),
) => {
  const collection = collectionFactory ?? (() => ({}));
  const connection = {
    db: {
      databaseName: 'retention_test',
      collection,
    },
  } as unknown as Connection;

  return new DataRetentionService(connection, worker);
};

describe('DataRetentionService', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('returns updated=0 for ordinary cleanup results', () => {
    const service = createService();
    const privateService = service as unknown as PrivateRetentionMethods;

    const result = privateService.result('reports', 3, 2, Date.now(), {
      processed: 2,
      deleted: 2,
    });

    expect(result.updated).toBe(0);
    expect(result.processed).toBe(result.deleted + result.skipped);
  });

  it('keeps test-marker dry-run side-effect free and globally bounded', async () => {
    const deleteMany = jest.fn();
    const countDocuments = jest
      .fn<() => Promise<number>>()
      .mockResolvedValue(1);
    const service = createService(() => ({ countDocuments, deleteMany }));

    const result = await service.run({
      mode: 'test-marker',
      execute: false,
      maxDocuments: 3,
    });

    expect(result.database).toBe('retention_test');
    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.results.reduce((sum, item) => sum + item.planned, 0)).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('applies one global budget across all report retention phases', async () => {
    const reconcileExhaustedClaims = jest
      .fn<RetentionPhase>()
      .mockResolvedValue(cleanupResult('manual_review', 2));
    const reconcileMissingPostEvidence = jest.fn<RetentionPhase>();
    const worker = createRetentionWorker({
      reconcileExhaustedClaims,
      reconcileMissingPostEvidence,
    });
    const service = createService(undefined, worker);

    const result = await service.run({
      mode: 'retention',
      execute: false,
      maxDocuments: 2,
    });

    expect(reconcileExhaustedClaims).toHaveBeenCalledWith(
      2,
      false,
      expect.any(Date),
    );
    expect(reconcileMissingPostEvidence).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it.each([
    { field: 'lostOwnership', value: 1 },
    { field: 'manualReview', value: 1 },
    { field: 'failed', value: 1 },
  ] as const)(
    'fails closed when a phase reports $field',
    async ({ field, value }) => {
      const phaseResult = {
        ...cleanupResult('manual_review', 1),
        processed: 1,
        [field]: value,
      };
      const worker = createRetentionWorker({
        reconcileExhaustedClaims: jest
          .fn<RetentionPhase>()
          .mockResolvedValue(phaseResult),
      });
      const service = createService(undefined, worker);

      const result = await service.run({
        mode: 'retention',
        execute: false,
        maxDocuments: 1,
      });

      expect(result).toMatchObject({
        success: false,
        requiresIntervention: true,
        [field]: value,
      });
    },
  );

  it('keeps truncation separate from intervention status', async () => {
    const phaseResult = {
      ...cleanupResult('manual_review', 1),
      truncated: true,
    };
    const worker = createRetentionWorker({
      reconcileExhaustedClaims: jest
        .fn<RetentionPhase>()
        .mockResolvedValue(phaseResult),
    });
    const service = createService(undefined, worker);

    const result = await service.run({
      mode: 'retention',
      execute: false,
      maxDocuments: 1,
    });

    expect(result).toMatchObject({
      success: true,
      requiresIntervention: false,
      hasMore: true,
    });
  });

  it('rejects test-marker mode in production', async () => {
    process.env.NODE_ENV = 'production';
    const service = createService();

    await expect(
      service.run({ mode: 'test-marker', execute: false }),
    ).rejects.toThrow('Không được cleanup test marker trong production');
  });

  it('requires explicit production confirmation for execute', async () => {
    process.env.NODE_ENV = 'production';
    const service = createService();

    await expect(
      service.run({
        mode: 'retention',
        execute: true,
        backupReference: 'atlas-backup-20260829',
      }),
    ).rejects.toThrow('CONFIRM_PRODUCTION_RETENTION_CLEANUP');
  });

  it('requires a non-secret backup reference for destructive retention', async () => {
    process.env.NODE_ENV = 'test';
    const service = createService();

    await expect(
      service.run({ mode: 'retention', execute: true }),
    ).rejects.toThrow('--backup-reference');
    await expect(
      service.run({
        mode: 'retention',
        execute: true,
        backupReference: 'short',
      }),
    ).rejects.toThrow('--backup-reference');
  });

  it('rejects an unsafe global budget', async () => {
    const service = createService();

    await expect(service.run({ maxDocuments: 0 })).rejects.toThrow(
      'maxDocuments phải là số nguyên',
    );
  });
});
