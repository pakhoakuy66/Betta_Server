import { AdminAccountStatus } from './admin-account.constants';
import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export const ADMIN_ACCOUNT_STATUS_MUTATION_VALUES = Object.freeze([
  AdminAccountStatus.ACTIVE,
  AdminAccountStatus.LOCKED,
]) as readonly AdminAccountStatus[];

export const ADMIN_ACCOUNT_STATUS_REASON_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_ACCOUNT_STATUS_REASON_NOTE_MAX_LENGTH = 500 as const;

export const getAdminAccountStatusPermission = (
  status: unknown,
): AdminPermissionValue | undefined => {
  if (status === AdminAccountStatus.LOCKED) {
    return AdminPermission.ADMINS_LOCK;
  }
  if (status === AdminAccountStatus.ACTIVE) {
    return AdminPermission.ADMINS_UNLOCK;
  }
  return undefined;
};
