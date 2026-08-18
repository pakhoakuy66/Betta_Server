import { describe, expect, it, jest } from '@jest/globals';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminUserSort } from '../constants/admin-user-query.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminUserQueryController } from './admin-user-query.controller';

describe('AdminUserQueryController', () => {
  const request = {
    user: { publicId: 'adm_23456789ABCD' },
  } as never;

  it('requires users.view and applies no-store to list responses', async () => {
    const users = {
      list: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ items: [], pagination: { page: 1, limit: 20 } }),
      ),
      detail: jest.fn(),
    };
    const accessLogger = { logList: jest.fn(), logDetail: jest.fn() };
    const controller = new AdminUserQueryController(
      users as never,
      accessLogger as never,
    );
    const response = { setHeader: jest.fn() };

    await controller.list(
      {
        page: 1,
        limit: 20,
        sort: AdminUserSort.CREATED_AT_DESC,
        search: 'user@betta.test',
      },
      request,
      response as never,
    );

    expect(
      Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, AdminUserQueryController),
    ).toEqual([AdminPermission.USERS_VIEW]);
    expect(users.list).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      status: undefined,
      deletion: undefined,
      restriction: undefined,
      loginLock: undefined,
      sort: AdminUserSort.CREATED_AT_DESC,
      search: 'user@betta.test',
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
      'user@betta.test',
    );
  });

  it('uses only a public ID for detail lookup', async () => {
    const users = {
      list: jest.fn(),
      detail: jest.fn<(publicId: string) => Promise<unknown>>(() =>
        Promise.resolve({ publicId: 'usr_23456789AB' }),
      ),
    };
    const accessLogger = { logList: jest.fn(), logDetail: jest.fn() };
    const controller = new AdminUserQueryController(
      users as never,
      accessLogger as never,
    );

    await controller.detail({ publicId: 'usr_23456789AB' }, request, {
      setHeader: jest.fn(),
    } as never);

    expect(users.detail).toHaveBeenCalledWith('usr_23456789AB');
    expect(accessLogger.logDetail).toHaveBeenCalledWith({
      actorPublicId: 'adm_23456789ABCD',
      targetPublicId: 'usr_23456789AB',
    });
  });
});
