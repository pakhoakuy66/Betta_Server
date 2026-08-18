import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export enum AdminUserDeletionOperation {
  DELETE = 'DELETE',
  RESTORE = 'RESTORE',
}

export const ADMIN_USER_DELETION_OPERATIONS = Object.freeze(
  Object.values(AdminUserDeletionOperation),
);
export const ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH = 500 as const;
export const ADMIN_USER_DELETION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const ADMIN_USER_DELETION_EVENT_TYPE =
  'moderation.user.deletion_changed' as const;
export const ADMIN_USER_DELETION_AGGREGATE_TYPE = 'user' as const;

export const getAdminUserDeletionPermission = (
  operation: unknown,
): AdminPermissionValue | undefined => {
  if (operation === AdminUserDeletionOperation.DELETE) {
    return AdminPermission.USERS_SOFT_DELETE;
  }
  if (operation === AdminUserDeletionOperation.RESTORE) {
    return AdminPermission.USERS_RESTORE;
  }
  return undefined;
};
