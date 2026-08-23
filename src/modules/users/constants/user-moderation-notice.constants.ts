export const USER_MODERATION_NOTICE_COLLECTION =
  'user_moderation_notices' as const;
export const USER_MODERATION_NOTICE_SCHEMA_VERSION = 1 as const;
export const USER_MODERATION_NOTICE_PUBLIC_ID_PATTERN =
  /^mnot_[A-Za-z0-9_-]{22}$/;
export const USER_MODERATION_NOTICE_RETENTION_DAYS = 365;
export const USER_MODERATION_NOTICE_TEMPORARY_GRACE_DAYS = 30;

export const USER_MODERATION_NOTICE_SOURCE_EVENT_INDEX =
  'user_moderation_notice_source_event_unique_v1' as const;
export const USER_MODERATION_NOTICE_SOURCE_DEDUPE_INDEX =
  'user_moderation_notice_source_dedupe_unique_v1' as const;
export const USER_MODERATION_NOTICE_SUPPORT_INDEX =
  'user_moderation_notice_support_unique_v1' as const;
export const USER_MODERATION_NOTICE_TIMELINE_INDEX =
  'user_moderation_notice_target_timeline_v1' as const;
export const USER_MODERATION_NOTICE_RETENTION_INDEX =
  'user_moderation_notice_retention_ttl_v1' as const;

export enum UserModerationNoticeAction {
  TEMPORARY_SUSPENSION_APPLIED = 'TEMPORARY_SUSPENSION_APPLIED',
  TEMPORARY_SUSPENSION_REMOVED = 'TEMPORARY_SUSPENSION_REMOVED',
  INDEFINITE_BAN_APPLIED = 'INDEFINITE_BAN_APPLIED',
  INDEFINITE_BAN_REMOVED = 'INDEFINITE_BAN_REMOVED',
  ADMIN_SOFT_DELETE_APPLIED = 'ADMIN_SOFT_DELETE_APPLIED',
  ADMIN_SOFT_DELETE_RESTORED = 'ADMIN_SOFT_DELETE_RESTORED',
}

export enum UserModerationNoticeStatus {
  ACTIVE = 'ACTIVE',
  RESOLVED = 'RESOLVED',
}

export const UserModerationPublicReason = Object.freeze({
  RESTRICTION_APPLIED: 'account_access_restricted',
  RESTRICTION_REMOVED: 'account_access_restored',
  ADMIN_DELETED: 'account_removed_by_moderation',
  ADMIN_RESTORED: 'account_restored_by_moderation',
});
