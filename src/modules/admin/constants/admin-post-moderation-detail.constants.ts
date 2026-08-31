export const ADMIN_POST_MODERATION_DETAIL_ACCESSED_EVENT =
  'admin.post_moderation_detail.accessed' as const;

export const ADMIN_POST_MODERATION_MEDIA_ALLOWED_HOSTS = Object.freeze([
  'res.cloudinary.com',
]);

export const ADMIN_POST_MODERATION_MEDIA_PATH_PATTERN =
  /^\/[A-Za-z0-9_-]+\/image\/upload\//u;

export const REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE =
  'REPORT_TARGET_SNAPSHOT_IMMUTABLE' as const;
