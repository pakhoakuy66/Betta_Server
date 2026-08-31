import { describe, expect, it, jest } from '@jest/globals';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  AdminReportQueueSort,
  AdminReportQueueStatus,
} from '../constants/admin-report-queue.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminReportQueueController } from './admin-report-queue.controller';

describe('AdminReportQueueController', () => {
  it('requires reports.view, applies no-store and logs no filters', async () => {
    const queue = {
      list: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({
          items: [],
          pagination: { page: 1, limit: 20, hasMore: false },
        }),
      ),
    };
    const accessLogger = { logList: jest.fn() };
    const controller = new AdminReportQueueController(
      queue as never,
      accessLogger as never,
    );
    const response = { setHeader: jest.fn() };

    await controller.list(
      {
        page: 1,
        limit: 20,
        status: AdminReportQueueStatus.PENDING,
        sort: AdminReportQueueSort.CREATED_AT_DESC,
      },
      { user: { publicId: 'adm_23456789ABCD' } } as never,
      response as never,
    );

    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        AdminReportQueueController,
      ),
    ).toEqual([AdminPermission.REPORTS_VIEW]);
    expect(queue.list).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      type: undefined,
      status: AdminReportQueueStatus.PENDING,
      reason: undefined,
      priority: undefined,
      assignee: undefined,
      sla: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(accessLogger.logList).toHaveBeenCalledWith({
      actorPublicId: 'adm_23456789ABCD',
      resultCount: 0,
    });
    expect(JSON.stringify(accessLogger.logList.mock.calls)).not.toContain(
      'PENDING',
    );
  });
});
