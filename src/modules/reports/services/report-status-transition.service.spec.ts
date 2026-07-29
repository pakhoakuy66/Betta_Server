import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { Report, ReportStatus } from '../schemas/report.schema';
import {
  RetentionCleanupStatus,
  SystemReport,
  SystemReportStatus,
} from '../schemas/system-report.schema';
import { ReportStatusTransitionService } from './report-status-transition.service';

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMock = {
  findById: Mock<(...args: unknown[]) => unknown>;
  updateOne: Mock<(...args: unknown[]) => unknown>;
};

const REPORT_ID = new Types.ObjectId('6a54d0377730aac9cc174525');

const NOW = new Date('2026-07-15T04:00:00.000Z');

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));

  return query;
};

const createModelMock = (): ModelMock => ({
  findById: jest.fn(),
  updateOne: jest.fn(),
});

const createContext = () => {
  const reportModel = createModelMock();
  const systemReportModel = createModelMock();

  const service = new ReportStatusTransitionService(
    reportModel as unknown as Model<Report>,
    systemReportModel as unknown as Model<SystemReport>,
  );

  return {
    service,
    reportModel,
    systemReportModel,
  };
};

describe('ReportStatusTransitionService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('transitionReport', () => {
    it('rejects a missing report', async () => {
      const { service, reportModel } = createContext();

      reportModel.findById.mockReturnValue(createQuery(null));

      await expect(
        service.transitionReport(REPORT_ID, ReportStatus.REVIEWING),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(reportModel.updateOne).not.toHaveBeenCalled();
    });

    it('rejects a no-op transition', async () => {
      const { service, reportModel } = createContext();

      reportModel.findById.mockReturnValue(
        createQuery({
          status: ReportStatus.REVIEWING,
          terminalAt: null,
        }),
      );

      await expect(
        service.transitionReport(REPORT_ID, ReportStatus.REVIEWING),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(reportModel.updateOne).not.toHaveBeenCalled();
    });

    it('sets terminalAt for a resolved report', async () => {
      const { service, reportModel } = createContext();

      reportModel.findById.mockReturnValue(
        createQuery({
          status: ReportStatus.REVIEWING,
          terminalAt: null,
        }),
      );

      reportModel.updateOne.mockImplementation(() =>
        Promise.resolve({ modifiedCount: 1 }),
      );

      await expect(
        service.transitionReport(REPORT_ID, ReportStatus.RESOLVED),
      ).resolves.toBeUndefined();

      expect(reportModel.updateOne).toHaveBeenCalledWith(
        {
          _id: REPORT_ID,
          status: ReportStatus.REVIEWING,
          terminalAt: null,
        },
        {
          $set: {
            status: ReportStatus.RESOLVED,
            terminalAt: NOW,
          },
        },
      );
    });

    it('clears terminalAt when moving to a non-terminal status', async () => {
      const { service, reportModel } = createContext();

      reportModel.findById.mockReturnValue(
        createQuery({
          status: ReportStatus.RESOLVED,
          terminalAt: new Date('2026-07-14T00:00:00.000Z'),
        }),
      );

      reportModel.updateOne.mockImplementation(() =>
        Promise.resolve({ modifiedCount: 1 }),
      );

      await service.transitionReport(REPORT_ID, ReportStatus.REVIEWING);

      expect(reportModel.updateOne).toHaveBeenCalledWith(expect.any(Object), {
        $set: {
          status: ReportStatus.REVIEWING,
          terminalAt: null,
        },
      });
    });

    it('detects an optimistic concurrency conflict', async () => {
      const { service, reportModel } = createContext();

      reportModel.findById.mockReturnValue(
        createQuery({
          status: ReportStatus.PENDING,
          terminalAt: null,
        }),
      );

      reportModel.updateOne.mockImplementation(() =>
        Promise.resolve({ modifiedCount: 0 }),
      );

      await expect(
        service.transitionReport(REPORT_ID, ReportStatus.REVIEWING),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('transitionSystemReport', () => {
    it('rejects transitions after retention cleanup starts', async () => {
      const { service, systemReportModel } = createContext();

      systemReportModel.findById.mockReturnValue(
        createQuery({
          status: SystemReportStatus.INVESTIGATING,
          terminalAt: null,
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
        }),
      );

      await expect(
        service.transitionSystemReport(REPORT_ID, SystemReportStatus.FIXED),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(systemReportModel.updateOne).not.toHaveBeenCalled();
    });

    it('supports legacy documents without retentionCleanupStatus', async () => {
      const { service, systemReportModel } = createContext();

      systemReportModel.findById.mockReturnValue(
        createQuery({
          status: SystemReportStatus.INVESTIGATING,
          terminalAt: null,
        }),
      );

      systemReportModel.updateOne.mockImplementation(() =>
        Promise.resolve({ modifiedCount: 1 }),
      );

      await service.transitionSystemReport(REPORT_ID, SystemReportStatus.FIXED);

      expect(systemReportModel.updateOne).toHaveBeenCalledWith(
        {
          _id: REPORT_ID,
          status: SystemReportStatus.INVESTIGATING,
          terminalAt: null,
          $or: [
            {
              retentionCleanupStatus: RetentionCleanupStatus.PENDING,
            },
            {
              retentionCleanupStatus: {
                $exists: false,
              },
            },
          ],
        },
        {
          $set: {
            status: SystemReportStatus.FIXED,
            terminalAt: NOW,
          },
        },
      );
    });

    it('detects concurrent system-report status changes', async () => {
      const { service, systemReportModel } = createContext();

      systemReportModel.findById.mockReturnValue(
        createQuery({
          status: SystemReportStatus.PENDING,
          terminalAt: null,
          retentionCleanupStatus: RetentionCleanupStatus.PENDING,
        }),
      );

      systemReportModel.updateOne.mockImplementation(() =>
        Promise.resolve({ modifiedCount: 0 }),
      );

      await expect(
        service.transitionSystemReport(
          REPORT_ID,
          SystemReportStatus.INVESTIGATING,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
