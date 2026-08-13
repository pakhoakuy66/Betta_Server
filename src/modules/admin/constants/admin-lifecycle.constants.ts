export const ADMIN_CREATE_REAUTH_TARGET_PUBLIC_ID =
  'security_admin_create' as const;
export const ADMIN_LIFECYCLE_COORDINATOR_KEY = 'admin_lifecycle' as const;
export const ADMIN_ACTIVATION_SECRET_NAME_PREFIX =
  'betta/admin/account-activation' as const;
export const ADMIN_LIFECYCLE_REASON_CODE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
export const ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,63}$/;
export const ADMIN_LIFECYCLE_USERNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/;
export const ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
export const ADMIN_LIFECYCLE_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
