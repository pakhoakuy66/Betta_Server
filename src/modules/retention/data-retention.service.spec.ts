import { describe, expect, it, jest, afterEach } from '@jest/globals';
import type { Connection, Model } from 'mongoose';
import { DataRetentionService } from './data-retention.service';
import type { SystemReport } from '../reports/schemas/system-report.schema';
import type { UploadsService } from '../uploads/services/uploads.service';
import type { CollectionCleanupResult } from './retention.types';

type PrivateRetentionMethods = {
  result: (
    collection: string,
    eligible: number,
    planned: number,
    startedAt: number,
    values?: Partial<CollectionCleanupResult>,
  ) => CollectionCleanupResult;
  reconcileExhaustedSystemReportClaims: (
    budget: number,
    execute: boolean,
    now: Date,
  ) => Promise<CollectionCleanupResult>;
};

const createService = (collectionFactory?: () => unknown) => {
  const collection = collectionFactory ?? (() => ({}));
  const connection = {
    db: {
      databaseName: 'retention_test',
      collection,
    },
  } as unknown as Connection;
  const systemReportModel = {} as Model<SystemReport>;
  const uploadsService = {} as UploadsService;

  return new DataRetentionService(
    connection,
    systemReportModel,
    uploadsService,
  );
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
      service.run({ mode: 'retention', execute: true }),
    ).rejects.toThrow('CONFIRM_PRODUCTION_RETENTION_CLEANUP');
  });

  it('rejects an unsafe global budget', async () => {
    const service = createService();

    await expect(service.run({ maxDocuments: 0 })).rejects.toThrow(
      'maxDocuments phải là số nguyên',
    );
  });

  it('does not mutate exhausted claims during dry-run', async () => {
    const countDocuments = jest
      .fn<() => Promise<number>>()
      .mockResolvedValue(2);
    const updateMany = jest.fn();
    const service = new DataRetentionService(
      {
        db: { databaseName: 'retention_test', collection: jest.fn() },
      } as unknown as Connection,
      { countDocuments, updateMany } as unknown as Model<SystemReport>,
      {} as UploadsService,
    );
    const privateService = service as unknown as PrivateRetentionMethods;

    const result = await privateService.reconcileExhaustedSystemReportClaims(
      1,
      false,
      new Date('2026-07-12T00:00:00.000Z'),
    );

    expect(result.planned).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.truncated).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reports reconciliation updates and ownership races', async () => {
    const ids = [{ _id: 'first' }, { _id: 'second' }];
    const exec = jest.fn<() => Promise<typeof ids>>().mockResolvedValue(ids);
    const lean = jest.fn(() => ({ exec }));
    const select = jest.fn(() => ({ lean }));
    const limit = jest.fn(() => ({ select }));
    const sort = jest.fn(() => ({ limit }));
    const find = jest.fn(() => ({ sort }));
    const countDocuments = jest
      .fn<() => Promise<number>>()
      .mockResolvedValue(2);
    const updateMany = jest
      .fn<() => Promise<{ modifiedCount: number }>>()
      .mockResolvedValue({ modifiedCount: 1 });
    const service = new DataRetentionService(
      {
        db: { databaseName: 'retention_test', collection: jest.fn() },
      } as unknown as Connection,
      { countDocuments, find, updateMany } as unknown as Model<SystemReport>,
      {} as UploadsService,
    );
    const privateService = service as unknown as PrivateRetentionMethods;

    const result = await privateService.reconcileExhaustedSystemReportClaims(
      2,
      true,
      new Date('2026-07-12T00:00:00.000Z'),
    );

    expect(result.processed).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(result.updated + result.skipped);
  });
});
