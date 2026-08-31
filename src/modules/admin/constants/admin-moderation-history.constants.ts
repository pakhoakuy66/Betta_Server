import { AdminAuditAction } from './admin-audit.constants';

export const ADMIN_MODERATION_HISTORY_DEFAULT_PAGE = 1 as const;
export const ADMIN_MODERATION_HISTORY_DEFAULT_LIMIT = 20 as const;
export const ADMIN_MODERATION_HISTORY_MAX_LIMIT = 100 as const;
export const ADMIN_MODERATION_HISTORY_MAX_OFFSET = 10_000 as const;
export const ADMIN_MODERATION_HISTORY_MAX_PAGE =
  ADMIN_MODERATION_HISTORY_MAX_OFFSET + 1;
export const ADMIN_MODERATION_HISTORY_ACCESSED_EVENT =
  'ADMIN_MODERATION_HISTORY_ACCESSED' as const;

export enum AdminModerationHistoryResource {
  USER = 'USER',
  POST = 'POST',
  REPORT = 'REPORT',
}

export enum AdminModerationHistoryTargetType {
  USER = 'USER',
  POST = 'POST',
  REPORT = 'REPORT',
  SYSTEM_REPORT = 'SYSTEM_REPORT',
}

export enum AdminModerationHistoryTargetAvailability {
  AVAILABLE = 'AVAILABLE',
  DELETED = 'DELETED',
}

export const ADMIN_MODERATION_HISTORY_ACTIONS = Object.freeze({
  USER: Object.freeze([
    AdminAuditAction.USER_SUSPENDED,
    AdminAuditAction.USER_UNSUSPENDED,
    AdminAuditAction.USER_BANNED,
    AdminAuditAction.USER_UNBANNED,
    AdminAuditAction.USER_DELETED,
    AdminAuditAction.USER_RESTORED,
  ]),
  POST: Object.freeze([
    AdminAuditAction.POST_HIDDEN,
    AdminAuditAction.POST_RESTORED,
    AdminAuditAction.POST_DELETED,
  ]),
  REPORT: Object.freeze([
    AdminAuditAction.REPORT_CLAIMED,
    AdminAuditAction.REPORT_REASSIGNED,
    AdminAuditAction.REPORT_RESOLVED,
    AdminAuditAction.REPORT_REJECTED,
  ]),
  SYSTEM_REPORT: Object.freeze([AdminAuditAction.SYSTEM_REPORT_TRANSITIONED]),
} satisfies Readonly<
  Record<AdminModerationHistoryTargetType, readonly AdminAuditAction[]>
>);

export type AdminModerationHistoryAction =
  (typeof ADMIN_MODERATION_HISTORY_ACTIONS)[AdminModerationHistoryTargetType][number];
