import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminAccountDeletionAction } from '../constants/admin-account-deletion.constants';
import { AdminAccountDeletionPermissionGuard } from './admin-account-deletion-permission.guard';

const context = (role: AdminRole, action: unknown) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          adminAccountId: '507f1f77bcf86cd799439011',
          id: 'adm_23456789ABCD',
          publicId: 'adm_23456789ABCD',
          username: 'root.admin',
          displayName: 'Root Admin',
          role,
          sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
          credentialVersion: 1,
          authzVersion: 1,
          permissionVersion: 1,
        },
        body: { action },
      }),
    }),
  }) as never;

describe('AdminAccountDeletionPermissionGuard', () => {
  const guard = new AdminAccountDeletionPermissionGuard();

  it.each(Object.values(AdminAccountDeletionAction))(
    'allows SuperAdmin action %s',
    (action) => {
      expect(guard.canActivate(context(AdminRole.SUPER_ADMIN, action))).toBe(
        true,
      );
    },
  );

  it('denies a regular Admin before service access', () => {
    expect(() =>
      guard.canActivate(
        context(AdminRole.ADMIN, AdminAccountDeletionAction.SOFT_DELETE),
      ),
    ).toThrow(ForbiddenException);
  });
});
