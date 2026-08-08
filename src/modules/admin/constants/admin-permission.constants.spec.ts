import { describe, expect, it } from '@jest/globals';
import { AdminRole } from './admin-account.constants';
import {
  ADMIN_PERMISSION_CATALOG,
  AdminPermission,
  getAdminRolePermissions,
  hasAdminPermission,
  isAdminPermission,
  isPackageAPermissionEnabled,
  PACKAGE_A_DISABLED_PERMISSIONS,
} from './admin-permission.constants';

const EXPECTED_PERMISSION_CATALOG = [
  'users.view',
  'users.suspend',
  'users.unsuspend',
  'users.ban',
  'users.unban',
  'users.soft_delete',
  'users.restore',
  'moderation_history.view',
  'posts.view',
  'posts.hide',
  'posts.delete',
  'posts.restore',
  'reports.view',
  'reports.contact_sensitive.view',
  'reports.review',
  'reports.resolve',
  'reports.reopen',
  'admins.view',
  'admins.create',
  'admins.lock',
  'admins.unlock',
  'admins.delete',
  'admins.restore',
  'admins.permissions.update',
  'sponsored_posts.view',
  'sponsored_posts.create',
  'sponsored_posts.update',
  'sponsored_posts.schedule',
  'sponsored_posts.pause',
  'sponsored_posts.delete',
  'sponsored_posts.restore',
  'audit_logs.view',
  'audit_logs.export',
  'dashboard.view',
] as const;

type ExpectedPermission = (typeof EXPECTED_PERMISSION_CATALOG)[number];

const EXPECTED_ADMIN_PERMISSIONS: readonly ExpectedPermission[] = [
  'users.view',
  'users.suspend',
  'users.unsuspend',
  'users.soft_delete',
  'users.restore',
  'moderation_history.view',
  'posts.view',
  'posts.hide',
  'posts.delete',
  'posts.restore',
  'reports.view',
  'reports.review',
  'reports.resolve',
];

const EXPECTED_SUPER_ADMIN_PERMISSIONS: readonly ExpectedPermission[] = [
  ...EXPECTED_ADMIN_PERMISSIONS,
  'users.ban',
  'users.unban',
  'reports.contact_sensitive.view',
  'admins.view',
  'admins.create',
  'admins.lock',
  'admins.unlock',
  'admins.delete',
  'admins.restore',
  'sponsored_posts.view',
  'sponsored_posts.create',
  'sponsored_posts.update',
  'sponsored_posts.schedule',
  'sponsored_posts.pause',
  'sponsored_posts.delete',
  'sponsored_posts.restore',
  'audit_logs.view',
];

const EXPECTED_DISABLED_PERMISSIONS: readonly ExpectedPermission[] = [
  'admins.permissions.update',
  'dashboard.view',
  'reports.reopen',
  'audit_logs.export',
];

const EXPECTED_ADMIN_SET = new Set<ExpectedPermission>(
  EXPECTED_ADMIN_PERMISSIONS,
);
const EXPECTED_SUPER_ADMIN_SET = new Set<ExpectedPermission>(
  EXPECTED_SUPER_ADMIN_PERMISSIONS,
);
const EXPECTED_DISABLED_SET = new Set<ExpectedPermission>(
  EXPECTED_DISABLED_PERMISSIONS,
);

describe('Admin permission catalog', () => {
  it('matches the complete 34-permission SRS oracle', () => {
    expect(Object.values(AdminPermission)).toEqual(EXPECTED_PERMISSION_CATALOG);
    expect(ADMIN_PERMISSION_CATALOG).toEqual(EXPECTED_PERMISSION_CATALOG);
    expect(new Set(ADMIN_PERMISSION_CATALOG).size).toBe(34);
  });

  it('matches the independent Package A disabled oracle', () => {
    expect(PACKAGE_A_DISABLED_PERMISSIONS).toEqual(
      EXPECTED_DISABLED_PERMISSIONS,
    );
  });

  it('matches the independent role permission oracles', () => {
    expect(getAdminRolePermissions(AdminRole.ADMIN)).toEqual(
      EXPECTED_ADMIN_PERMISSIONS,
    );
    expect(getAdminRolePermissions(AdminRole.SUPER_ADMIN)).toEqual(
      EXPECTED_SUPER_ADMIN_PERMISSIONS,
    );
  });

  it('validates all 34 x 2 SRS permission matrix cells', () => {
    for (const permission of EXPECTED_PERMISSION_CATALOG) {
      expect(hasAdminPermission(AdminRole.ADMIN, permission)).toBe(
        EXPECTED_ADMIN_SET.has(permission),
      );
      expect(hasAdminPermission(AdminRole.SUPER_ADMIN, permission)).toBe(
        EXPECTED_SUPER_ADMIN_SET.has(permission),
      );
      expect(isPackageAPermissionEnabled(permission)).toBe(
        !EXPECTED_DISABLED_SET.has(permission),
      );
    }
  });

  it('denies unknown roles and arbitrary permission strings', () => {
    expect(hasAdminPermission('MODERATOR', 'users.view')).toBe(false);
    expect(hasAdminPermission(AdminRole.SUPER_ADMIN, 'root.all')).toBe(false);
    expect(getAdminRolePermissions('MODERATOR')).toEqual([]);
    expect(isAdminPermission('root.all')).toBe(false);
  });

  it('freezes every exported policy collection at runtime', () => {
    expect(Object.isFrozen(AdminPermission)).toBe(true);
    expect(Object.isFrozen(ADMIN_PERMISSION_CATALOG)).toBe(true);
    expect(Object.isFrozen(PACKAGE_A_DISABLED_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(getAdminRolePermissions(AdminRole.ADMIN))).toBe(
      true,
    );
    expect(
      Object.isFrozen(getAdminRolePermissions(AdminRole.SUPER_ADMIN)),
    ).toBe(true);
  });
});
