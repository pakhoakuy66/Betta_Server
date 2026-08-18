import { describe, expect, it } from '@jest/globals';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { AdminPermission } from './admin-permission.constants';
import {
  AdminUserRestrictionOperation,
  getAdminUserRestrictionPermission,
} from './admin-user-restriction.constants';

describe('Admin User restriction permission mapping', () => {
  it.each([
    [
      AdminUserRestrictionOperation.APPLY,
      UserRestrictionType.TEMPORARY_SUSPENSION,
      AdminPermission.USERS_SUSPEND,
    ],
    [
      AdminUserRestrictionOperation.REMOVE,
      UserRestrictionType.TEMPORARY_SUSPENSION,
      AdminPermission.USERS_UNSUSPEND,
    ],
    [
      AdminUserRestrictionOperation.APPLY,
      UserRestrictionType.INDEFINITE_BAN,
      AdminPermission.USERS_BAN,
    ],
    [
      AdminUserRestrictionOperation.REMOVE,
      UserRestrictionType.INDEFINITE_BAN,
      AdminPermission.USERS_UNBAN,
    ],
  ])('maps %s %s to %s', (operation, type, permission) => {
    expect(getAdminUserRestrictionPermission(operation, type)).toBe(permission);
  });

  it('fails closed for unknown combinations', () => {
    expect(
      getAdminUserRestrictionPermission('APPLY', 'UNKNOWN'),
    ).toBeUndefined();
  });
});
