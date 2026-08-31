import { describe, expect, it, jest } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminPostModerationController } from './admin-post-moderation.controller';
import type { AdminPostModerationService } from '../services/admin-post-moderation.service';

describe('AdminPostModerationController', () => {
  const update = jest.fn<AdminPostModerationService['update']>();
  const controller = new AdminPostModerationController({
    update,
  } as unknown as AdminPostModerationService);

  const request = {
    user: {
      adminAccountId: '507f1f77bcf86cd799439011',
      publicId: 'adm_5mUfVZfKbnXM',
      username: 'moderator',
      displayName: 'Moderator',
      role: AdminRole.ADMIN,
      permissionVersion: 1,
      sessionId: 'ases_23456789ABCDEFGH',
      credentialVersion: 0,
      authzVersion: 0,
    },
  };

  it.each([
    ['hide', AdminPermission.POSTS_HIDE],
    ['restore', AdminPermission.POSTS_RESTORE],
    ['terminalDelete', AdminPermission.POSTS_DELETE],
  ] as const)('locks %s to its dedicated permission', (method, permission) => {
    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        AdminPostModerationController.prototype[method],
      ),
    ).toEqual([permission]);
  });

  it('sets no-store headers and forwards expectedModerationVersion', async () => {
    update.mockResolvedValue({
      post: {
        id: 'post_23456789ABCD',
        publicId: 'post_23456789ABCD',
        state: 'hidden' as never,
        moderationVersion: 1,
        moderatedAt: new Date().toISOString(),
        cleanupRequested: false,
      },
    });
    const setHeader = jest.fn();
    await controller.hide(
      { publicId: 'post_23456789ABCD' },
      {
        expectedModerationVersion: 0,
        reasonCode: 'moderation_policy',
      },
      'idem_23456789ABCDEFGH',
      request as never,
      { setHeader } as never,
    );

    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedModerationVersion: 0,
        reasonCode: 'moderation_policy',
      }),
    );
    expect(JSON.stringify(update.mock.calls[0]?.[0])).not.toContain(
      'publicReasonCode',
    );
  });
});
