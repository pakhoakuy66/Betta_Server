import { describe, expect, it, jest } from '@jest/globals';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  AdminModerationHistoryResource,
  AdminModerationHistoryTargetAvailability,
  AdminModerationHistoryTargetType,
} from '../constants/admin-moderation-history.constants';
import { AdminModerationHistoryController } from './admin-moderation-history.controller';

const permissionsFor = (method: keyof AdminModerationHistoryController) =>
  Reflect.getMetadata(
    ADMIN_PERMISSIONS_METADATA,
    AdminModerationHistoryController.prototype[method],
  ) as readonly AdminPermission[];

describe('AdminModerationHistoryController', () => {
  it('locks each target route to history plus its resource view permission', () => {
    expect(permissionsFor('listUser')).toEqual([
      AdminPermission.USERS_VIEW,
      AdminPermission.MODERATION_HISTORY_VIEW,
    ]);
    expect(permissionsFor('listPost')).toEqual([
      AdminPermission.POSTS_VIEW,
      AdminPermission.MODERATION_HISTORY_VIEW,
    ]);
    expect(permissionsFor('listReport')).toEqual([
      AdminPermission.REPORTS_VIEW,
      AdminPermission.MODERATION_HISTORY_VIEW,
    ]);
  });

  it('sets privacy headers and passes only the public target to the service', async () => {
    const page = {
      target: {
        type: AdminModerationHistoryTargetType.POST,
        publicId: 'post_23456789ABCD',
        availability: AdminModerationHistoryTargetAvailability.AVAILABLE,
      },
      items: [],
      pagination: { page: 1, limit: 20, hasMore: false },
    };
    const history = {
      list: jest.fn<(input: unknown) => Promise<typeof page>>(() =>
        Promise.resolve(page),
      ),
    };
    const controller = new AdminModerationHistoryController(history as never);
    const response = { setHeader: jest.fn() };

    await expect(
      controller.listPost(
        { publicId: 'post_23456789ABCD' },
        { page: 1, limit: 20 },
        { user: { publicId: 'adm_23456789ABCD' } } as never,
        response as never,
      ),
    ).resolves.toEqual(page);

    expect(history.list).toHaveBeenCalledWith({
      resource: AdminModerationHistoryResource.POST,
      targetPublicId: 'post_23456789ABCD',
      page: 1,
      limit: 20,
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
  });
});
