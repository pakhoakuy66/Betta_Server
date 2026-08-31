import {
  CanonicalModerationReasonCode,
  PublicModerationReasonCode,
} from '../../../common/moderation/moderation-reason.constants';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export enum AdminUserRestrictionOperation {
  APPLY = 'APPLY',
  REMOVE = 'REMOVE',
}

export const ADMIN_USER_RESTRICTION_OPERATIONS = Object.freeze(
  Object.values(AdminUserRestrictionOperation),
);
export const ADMIN_USER_RESTRICTION_TYPES = Object.freeze(
  Object.values(UserRestrictionType),
);
export const ADMIN_USER_RESTRICTION_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.MODERATION_POLICY,
  CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
  CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
]);
export const ADMIN_USER_RESTRICTION_PUBLIC_REASON_CODES = Object.freeze([
  PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
  PublicModerationReasonCode.SEVERE_POLICY_VIOLATION,
]);
export const ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH = 500 as const;
export const ADMIN_USER_RESTRICTION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const ADMIN_USER_RESTRICTION_EVENT_TYPE =
  'moderation.user.restriction_changed' as const;
export const ADMIN_USER_RESTRICTION_AGGREGATE_TYPE = 'user' as const;

export const getAdminUserRestrictionPermission = (
  operation: unknown,
  restrictionType: unknown,
): AdminPermissionValue | undefined => {
  if (operation === AdminUserRestrictionOperation.APPLY) {
    if (restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION) {
      return AdminPermission.USERS_SUSPEND;
    }
    if (restrictionType === UserRestrictionType.INDEFINITE_BAN) {
      return AdminPermission.USERS_BAN;
    }
  }
  if (operation === AdminUserRestrictionOperation.REMOVE) {
    if (restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION) {
      return AdminPermission.USERS_UNSUSPEND;
    }
    if (restrictionType === UserRestrictionType.INDEFINITE_BAN) {
      return AdminPermission.USERS_UNBAN;
    }
  }
  return undefined;
};
