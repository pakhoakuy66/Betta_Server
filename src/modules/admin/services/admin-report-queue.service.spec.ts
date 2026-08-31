import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { ReportQueuePriority } from '../../reports/constants/report-queue.constants';
import {
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import {
  SystemReportSource,
  SystemReportStatus,
  SystemReportType,
} from '../../reports/schemas/system-report.schema';
import {
  ADMIN_REPORT_QUEUE_UNASSIGNED,
  AdminReportQueueSlaFilter,
  AdminReportQueueSort,
  AdminReportQueueType,
} from '../constants/admin-report-queue.constants';
import { AdminReportTargetAvailability } from '../interfaces/admin-report-queue.interface';
import { AdminReportQueueService } from './admin-report-queue.service';

const chain = <T>(rows: T[] | Error) => {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn(),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  query.exec.mockImplementation(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  return query;
};

const model = <T>(rows: T[] | Error) => ({
  find: jest.fn((...args: unknown[]) => {
    void args;
    return chain(rows);
  }),
});

const createdAt = new Date('2026-08-24T00:00:00.000Z');
const triageDueAt = new Date('2026-08-25T00:00:00.000Z');
const decisionDueAt = new Date('2026-08-27T00:00:00.000Z');

describe('AdminReportQueueService', () => {
  it('merges deterministically and returns an allowlisted projection', async () => {
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const reports = model([
      {
        publicId: 'rpt_23456789ABCDEFGH',
        targetId: userId,
        targetType: ReportTargetType.USER,
        reasonCode: 'public_figure',
        reasonGroup: ReportReasonGroup.IMPERSONATION,
        status: ReportStatus.PENDING,
        priority: ReportQueuePriority.STANDARD,
        assigneePublicId: null,
        assignedAt: null,
        triageDueAt,
        decisionDueAt,
        targetSnapshot: {
          publicId: 'usr_23456789AB',
          username: 'target_user',
        },
        version: 0,
        createdAt,
        terminalAt: null,
      },
      {
        publicId: 'rpt_3456789ABCDEFGHJ',
        targetId: postId,
        targetType: ReportTargetType.POST,
        reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
        status: ReportStatus.REVIEWING,
        priority: ReportQueuePriority.P0,
        assigneePublicId: 'adm_23456789ABCD',
        assignedAt: createdAt,
        triageDueAt,
        decisionDueAt,
        targetSnapshot: {
          publicId: 'post_23456789ABCD',
          authorUsername: 'author',
          expireAt: new Date('2026-08-23T00:00:00.000Z'),
        },
        version: 2,
        createdAt,
        terminalAt: null,
      },
    ]);
    const systemReports = model([
      {
        publicId: 'srep_23456789ABCDEFGH',
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        category: 'LOGIN_PROBLEM',
        contactEmailMasked: 'p***@e***.com',
        status: SystemReportStatus.PENDING,
        priority: ReportQueuePriority.STANDARD,
        assigneePublicId: null,
        assignedAt: null,
        triageDueAt,
        decisionDueAt,
        version: 0,
        createdAt,
        terminalAt: null,
      },
    ]);
    const users = model([{ _id: userId, isDeleted: false }]);
    const posts = model([
      { _id: postId, expireAt: new Date('2026-08-23T00:00:00.000Z') },
    ]);
    const service = new AdminReportQueueService(
      reports as never,
      systemReports as never,
      users as never,
      posts as never,
    );

    const result = await service.list({
      page: 1,
      limit: 20,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });

    expect(result.items.map((item) => item.publicId)).toEqual([
      'rpt_23456789ABCDEFGH',
      'rpt_3456789ABCDEFGHJ',
      'srep_23456789ABCDEFGH',
    ]);
    expect(result.items[0]?.reasonCode).toBe('public_figure');
    expect(result.items[1]?.reasonCode).toBe(
      ReportReasonGroup.VIOLATION_CONTENT,
    );
    expect(result.items[0]?.target.availability).toBe(
      AdminReportTargetAvailability.AVAILABLE,
    );
    expect(result.items[1]?.target.availability).toBe(
      AdminReportTargetAvailability.EXPIRED,
    );
    expect(result.items[2]?.target.availability).toBe(
      AdminReportTargetAvailability.NOT_APPLICABLE,
    );
    expect(result.items[2]?.contact).toEqual({
      emailMasked: 'p***@e***.com',
    });
    const projection = reports.find.mock.calls[0]?.[1];
    if (!projection || typeof projection !== 'object') {
      throw new Error('Projection was not supplied');
    }
    for (const forbidden of [
      'reporterId',
      'reasonDetail',
      'description',
      'adminNote',
      'evidenceImages',
      'encryptedContactEmail',
      'contactLookupHmac',
    ]) {
      expect(projection[forbidden]).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
  });

  it('uses MongoDB binary publicId order for deterministic tie-breaks', async () => {
    const targetId = new Types.ObjectId();
    const baseRecord = {
      targetId,
      targetType: ReportTargetType.USER,
      reasonGroup: ReportReasonGroup.IMPERSONATION,
      status: ReportStatus.PENDING,
      priority: ReportQueuePriority.STANDARD,
      assigneePublicId: null,
      assignedAt: null,
      triageDueAt,
      decisionDueAt,
      targetSnapshot: {
        publicId: 'usr_23456789AB',
        username: 'target_user',
      },
      version: 0,
      createdAt,
      terminalAt: null,
    };

    const reports = model([
      {
        ...baseRecord,
        publicId: 'rpt_aaaaaaaaaaaaaaaa',
      },
      {
        ...baseRecord,
        publicId: 'rpt_AAAAAAAAAAAAAAAA',
      },
    ]);

    const service = new AdminReportQueueService(
      reports as never,
      model([]) as never,
      model([{ _id: targetId, isDeleted: false }]) as never,
      model([]) as never,
    );

    const result = await service.list({
      page: 1,
      limit: 20,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });

    expect(result.items.map((item) => item.publicId)).toEqual([
      'rpt_AAAAAAAAAAAAAAAA',
      'rpt_aaaaaaaaaaaaaaaa',
    ]);
  });

  it('limits branches by type and builds assignee/SLA filters', async () => {
    const reports = model([]);
    const systemReports = model([]);
    const service = new AdminReportQueueService(
      reports as never,
      systemReports as never,
      model([]) as never,
      model([]) as never,
    );

    await service.list({
      page: 1,
      limit: 20,
      type: AdminReportQueueType.ACCOUNT_ACCESS,
      assignee: ADMIN_REPORT_QUEUE_UNASSIGNED,
      sla: AdminReportQueueSlaFilter.BREACHED,
      sort: AdminReportQueueSort.TRIAGE_DUE_ASC,
    });

    expect(reports.find).not.toHaveBeenCalled();
    expect(systemReports.find).toHaveBeenCalledTimes(1);
    const filter = JSON.stringify(systemReports.find.mock.calls[0]?.[0]);
    expect(filter).toContain('ACCOUNT_ACCESS');
    expect(filter).toContain('assigneePublicId');
    expect(filter).toContain('triageDueAt');
  });

  it('rejects inverted ranges before persistence', async () => {
    const reports = model([]);
    const systemReports = model([]);
    const service = new AdminReportQueueService(
      reports as never,
      systemReports as never,
      model([]) as never,
      model([]) as never,
    );

    await expect(
      service.list({
        page: 1,
        limit: 20,
        createdFrom: '2026-08-25T00:00:00.000Z',
        createdTo: '2026-08-24T00:00:00.000Z',
        sort: AdminReportQueueSort.CREATED_AT_DESC,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.find).not.toHaveBeenCalled();
  });

  it('sanitizes persistence outages', async () => {
    const reports = model(new Error('mongodb.internal:27017 secret'));
    const service = new AdminReportQueueService(
      reports as never,
      model([]) as never,
      model([]) as never,
      model([]) as never,
    );

    const result = service.list({
      page: 1,
      limit: 20,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: expect.not.objectContaining({
        message: expect.stringContaining('mongodb.internal'),
      }),
    });
  });
});
