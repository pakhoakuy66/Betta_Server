import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export enum AdminAccountDeletionAction {
  SOFT_DELETE = 'SOFT_DELETE',
  RESTORE = 'RESTORE',
}

export const ADMIN_ACCOUNT_DELETION_ACTION_VALUES = Object.freeze(
  Object.values(AdminAccountDeletionAction),
) as readonly AdminAccountDeletionAction[];

export const ADMIN_ACCOUNT_DELETION_REASON_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_ACCOUNT_DELETION_REASON_NOTE_MAX_LENGTH = 500 as const;

export const getAdminAccountDeletionPermission = (
  action: unknown,
): AdminPermissionValue | undefined => {
  if (action === AdminAccountDeletionAction.SOFT_DELETE) {
    return AdminPermission.ADMINS_DELETE;
  }
  if (action === AdminAccountDeletionAction.RESTORE) {
    return AdminPermission.ADMINS_RESTORE;
  }
  return undefined;
};
