import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { ReportQueuePriority } from '../../reports/constants/report-queue.constants';
import {
  ADMIN_REPORT_QUEUE_UNASSIGNED,
  AdminReportQueueSlaFilter,
  AdminReportQueueSort,
  AdminReportQueueStatus,
  AdminReportQueueType,
} from '../constants/admin-report-queue.constants';
import { ListAdminReportQueueDto } from './list-admin-report-queue.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

describe('ListAdminReportQueueDto', () => {
  it('transforms only allowlisted filters with explicit timezones', async () => {
    const result = (await pipe.transform(
      {
        page: '2',
        limit: '100',
        type: AdminReportQueueType.POST,
        status: AdminReportQueueStatus.REVIEWING,
        reason: '  violation_content  ',
        priority: ReportQueuePriority.P0,
        assignee: `  ${ADMIN_REPORT_QUEUE_UNASSIGNED}  `,
        sla: AdminReportQueueSlaFilter.BREACHED,
        createdFrom: '2026-08-20T00:00:00.000Z',
        createdTo: '2026-08-24T07:00:00.000+07:00',
        sort: AdminReportQueueSort.TRIAGE_DUE_ASC,
      },
      { type: 'query', metatype: ListAdminReportQueueDto },
    )) as ListAdminReportQueueDto;

    expect(result).toMatchObject({
      page: 2,
      limit: 100,
      type: AdminReportQueueType.POST,
      status: AdminReportQueueStatus.REVIEWING,
      reason: 'violation_content',
      priority: ReportQueuePriority.P0,
      assignee: ADMIN_REPORT_QUEUE_UNASSIGNED,
      sla: AdminReportQueueSlaFilter.BREACHED,
      createdFrom: '2026-08-20T00:00:00.000Z',
      createdTo: '2026-08-24T07:00:00.000+07:00',
      sort: AdminReportQueueSort.TRIAGE_DUE_ASC,
    });
  });

  it.each([
    { page: '101' },
    { limit: '101' },
    { type: '$where' },
    { status: 'ALL' },
    { reason: '{"$ne":null}' },
    { priority: 'URGENT' },
    { assignee: 'adm_invalid' },
    { sla: 'OVERDUE OR 1=1' },
    { createdFrom: '2026-08-20T00:00:00' },
    { createdTo: 'not-a-date' },
    { sort: 'createdAt;-1' },
    { unknown: 'field' },
  ])('rejects malformed or non-allowlisted query %#', async (input) => {
    await expect(
      pipe.transform(input, {
        type: 'query',
        metatype: ListAdminReportQueueDto,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('keeps bounded defaults for an empty query', () => {
    expect(plainToInstance(ListAdminReportQueueDto, {})).toMatchObject({
      page: 1,
      limit: 20,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });
  });
});
