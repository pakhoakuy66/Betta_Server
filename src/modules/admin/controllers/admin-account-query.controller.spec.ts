import { describe, expect, it, jest } from '@jest/globals';
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminAccountQueryController } from './admin-account-query.controller';

describe('AdminAccountQueryController', () => {
  it('requires admins.view and applies no-store to list responses', async () => {
    const accounts = {
      list: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ items: [], pagination: { page: 1, limit: 20 } }),
      ),
      detail: jest.fn(),
    };
    const controller = new AdminAccountQueryController(accounts as never);
    const response = { setHeader: jest.fn() };

    await controller.list(
      { page: 1, limit: 20, search: 'admin@betta.test' },
      response as never,
    );

    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        AdminAccountQueryController,
      ),
    ).toEqual([AdminPermission.ADMINS_VIEW]);
    expect(accounts.list).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      role: undefined,
      status: undefined,
      mfaStatus: undefined,
      search: 'admin@betta.test',
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
  });

  it('uses only a public ID for detail lookup', async () => {
    const accounts = {
      list: jest.fn(),
      detail: jest.fn<(publicId: string) => Promise<unknown>>(() =>
        Promise.resolve({ publicId: 'adm_23456789ABCD' }),
      ),
    };
    const controller = new AdminAccountQueryController(accounts as never);
    const response = { setHeader: jest.fn() };

    await controller.detail(
      { publicId: 'adm_23456789ABCD' },
      response as never,
    );

    expect(accounts.detail).toHaveBeenCalledWith('adm_23456789ABCD');
  });
});
