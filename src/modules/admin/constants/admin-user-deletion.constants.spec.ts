import { describe, expect, it } from '@jest/globals';
import { AdminPermission } from './admin-permission.constants';
import {
  AdminUserDeletionOperation,
  getAdminUserDeletionPermission,
} from './admin-user-deletion.constants';

describe('Admin User deletion policy', () => {
  it.each([
    [AdminUserDeletionOperation.DELETE, AdminPermission.USERS_SOFT_DELETE],
    [AdminUserDeletionOperation.RESTORE, AdminPermission.USERS_RESTORE],
  ])('maps %s to %s', (operation, permission) => {
    expect(getAdminUserDeletionPermission(operation)).toBe(permission);
  });

  it('fails closed for unsupported operations', () => {
    expect(getAdminUserDeletionPermission('HARD_DELETE')).toBeUndefined();
  });
});
