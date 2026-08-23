import { AdminAuditAction } from './admin-audit.constants';

export const ADMIN_USER_MODERATION_HISTORY_ACTIONS = Object.freeze([
  AdminAuditAction.USER_SUSPENDED,
  AdminAuditAction.USER_UNSUSPENDED,
  AdminAuditAction.USER_BANNED,
  AdminAuditAction.USER_UNBANNED,
  AdminAuditAction.USER_DELETED,
  AdminAuditAction.USER_RESTORED,
] as const);

export type AdminUserModerationHistoryAction =
  (typeof ADMIN_USER_MODERATION_HISTORY_ACTIONS)[number];

export const ADMIN_USER_MODERATION_HISTORY_MAX_OFFSET = 10_000;
export const ADMIN_USER_MODERATION_HISTORY_ACCESSED_EVENT =
  'admin.user.moderation_history.accessed' as const;
