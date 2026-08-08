import { AdminRole } from './admin-account.constants';

export const AdminPermission = Object.freeze({
  USERS_VIEW: 'users.view',
  USERS_SUSPEND: 'users.suspend',
  USERS_UNSUSPEND: 'users.unsuspend',
  USERS_BAN: 'users.ban',
  USERS_UNBAN: 'users.unban',
  USERS_SOFT_DELETE: 'users.soft_delete',
  USERS_RESTORE: 'users.restore',
  MODERATION_HISTORY_VIEW: 'moderation_history.view',
  POSTS_VIEW: 'posts.view',
  POSTS_HIDE: 'posts.hide',
  POSTS_DELETE: 'posts.delete',
  POSTS_RESTORE: 'posts.restore',
  REPORTS_VIEW: 'reports.view',
  REPORTS_CONTACT_SENSITIVE_VIEW: 'reports.contact_sensitive.view',
  REPORTS_REVIEW: 'reports.review',
  REPORTS_RESOLVE: 'reports.resolve',
  REPORTS_REOPEN: 'reports.reopen',
  ADMINS_VIEW: 'admins.view',
  ADMINS_CREATE: 'admins.create',
  ADMINS_LOCK: 'admins.lock',
  ADMINS_UNLOCK: 'admins.unlock',
  ADMINS_DELETE: 'admins.delete',
  ADMINS_RESTORE: 'admins.restore',
  ADMINS_PERMISSIONS_UPDATE: 'admins.permissions.update',
  SPONSORED_POSTS_VIEW: 'sponsored_posts.view',
  SPONSORED_POSTS_CREATE: 'sponsored_posts.create',
  SPONSORED_POSTS_UPDATE: 'sponsored_posts.update',
  SPONSORED_POSTS_SCHEDULE: 'sponsored_posts.schedule',
  SPONSORED_POSTS_PAUSE: 'sponsored_posts.pause',
  SPONSORED_POSTS_DELETE: 'sponsored_posts.delete',
  SPONSORED_POSTS_RESTORE: 'sponsored_posts.restore',
  AUDIT_LOGS_VIEW: 'audit_logs.view',
  AUDIT_LOGS_EXPORT: 'audit_logs.export',
  DASHBOARD_VIEW: 'dashboard.view',
} as const);

export type AdminPermission =
  (typeof AdminPermission)[keyof typeof AdminPermission];

export const ADMIN_PERMISSION_CATALOG = Object.freeze(
  Object.values(AdminPermission),
) as readonly AdminPermission[];

export const PACKAGE_A_DISABLED_PERMISSIONS = Object.freeze([
  AdminPermission.ADMINS_PERMISSIONS_UPDATE,
  AdminPermission.DASHBOARD_VIEW,
  AdminPermission.REPORTS_REOPEN,
  AdminPermission.AUDIT_LOGS_EXPORT,
]) as readonly AdminPermission[];

const ADMIN_PERMISSIONS = Object.freeze([
  AdminPermission.USERS_VIEW,
  AdminPermission.USERS_SUSPEND,
  AdminPermission.USERS_UNSUSPEND,
  AdminPermission.USERS_SOFT_DELETE,
  AdminPermission.USERS_RESTORE,
  AdminPermission.MODERATION_HISTORY_VIEW,
  AdminPermission.POSTS_VIEW,
  AdminPermission.POSTS_HIDE,
  AdminPermission.POSTS_DELETE,
  AdminPermission.POSTS_RESTORE,
  AdminPermission.REPORTS_VIEW,
  AdminPermission.REPORTS_REVIEW,
  AdminPermission.REPORTS_RESOLVE,
]) as readonly AdminPermission[];

const SUPER_ADMIN_PERMISSIONS: readonly AdminPermission[] = Object.freeze([
  ...ADMIN_PERMISSIONS,
  AdminPermission.USERS_BAN,
  AdminPermission.USERS_UNBAN,
  AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
  AdminPermission.ADMINS_VIEW,
  AdminPermission.ADMINS_CREATE,
  AdminPermission.ADMINS_LOCK,
  AdminPermission.ADMINS_UNLOCK,
  AdminPermission.ADMINS_DELETE,
  AdminPermission.ADMINS_RESTORE,
  AdminPermission.SPONSORED_POSTS_VIEW,
  AdminPermission.SPONSORED_POSTS_CREATE,
  AdminPermission.SPONSORED_POSTS_UPDATE,
  AdminPermission.SPONSORED_POSTS_SCHEDULE,
  AdminPermission.SPONSORED_POSTS_PAUSE,
  AdminPermission.SPONSORED_POSTS_DELETE,
  AdminPermission.SPONSORED_POSTS_RESTORE,
  AdminPermission.AUDIT_LOGS_VIEW,
]);

const EMPTY_PERMISSIONS = Object.freeze([]) as readonly AdminPermission[];
const CATALOG_SET = new Set<AdminPermission>(ADMIN_PERMISSION_CATALOG);
const DISABLED_SET = new Set<AdminPermission>(PACKAGE_A_DISABLED_PERMISSIONS);
const ROLE_PERMISSION_SETS: ReadonlyMap<
  AdminRole,
  ReadonlySet<AdminPermission>
> = new Map([
  [AdminRole.ADMIN, new Set(ADMIN_PERMISSIONS)],
  [AdminRole.SUPER_ADMIN, new Set(SUPER_ADMIN_PERMISSIONS)],
]);

export const isAdminPermission = (value: unknown): value is AdminPermission =>
  typeof value === 'string' && CATALOG_SET.has(value as AdminPermission);

export const isPackageAPermissionEnabled = (
  permission: unknown,
): permission is AdminPermission =>
  isAdminPermission(permission) && !DISABLED_SET.has(permission);

export const getAdminRolePermissions = (
  role: unknown,
): readonly AdminPermission[] => {
  if (role === AdminRole.ADMIN) return ADMIN_PERMISSIONS;
  if (role === AdminRole.SUPER_ADMIN) return SUPER_ADMIN_PERMISSIONS;
  return EMPTY_PERMISSIONS;
};

export const hasAdminPermission = (
  role: unknown,
  permission: unknown,
): boolean => {
  if (!isPackageAPermissionEnabled(permission)) return false;
  if (role !== AdminRole.ADMIN && role !== AdminRole.SUPER_ADMIN) return false;

  return ROLE_PERMISSION_SETS.get(role)?.has(permission) === true;
};
