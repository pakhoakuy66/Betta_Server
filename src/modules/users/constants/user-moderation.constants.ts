export const USER_MODERATION_SCHEMA_VERSION = 1 as const;
export const USER_MODERATION_MIGRATION_VERSION = 1 as const;

export const USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN =
  /^sup_[A-Za-z0-9_-]{8,64}$/;
export const USER_RESTRICTION_PUBLIC_REASON_PATTERN =
  /^[a-z][a-z0-9_.-]{2,63}$/;

export enum UserRestrictionType {
  TEMPORARY_SUSPENSION = 'TEMPORARY_SUSPENSION',
  INDEFINITE_BAN = 'INDEFINITE_BAN',
}

export enum UserDeletionOrigin {
  ADMIN_MODERATION = 'ADMIN_MODERATION',
  USER_SELF_DELETED = 'USER_SELF_DELETED',
}

export const USER_MODERATION_MIGRATABLE_FIELDS = Object.freeze([
  'isDeleted',
  'restriction',
  'deletionOrigin',
  'restorableUntil',
  'version',
  'authzVersion',
  'moderationSchemaVersion',
] as const);

export type UserModerationMigratableField =
  (typeof USER_MODERATION_MIGRATABLE_FIELDS)[number];

export const LEGACY_BAN_PUBLIC_REASON_CODE = 'legacy_indefinite_ban' as const;

export const USER_RESTRICTION_INDEX_NAME =
  'user_restriction_type_expiry_id' as const;
export const USER_DELETION_ORIGIN_INDEX_NAME =
  'user_deletion_origin_deleted_id' as const;
