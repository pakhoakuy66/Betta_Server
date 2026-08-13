export const ADMIN_PASSWORD_MIN_LENGTH = 8;
export const ADMIN_PASSWORD_MAX_LENGTH = 64;
export const ADMIN_PASSWORD_MAX_UTF8_BYTES = 72;
export const ADMIN_PASSWORD_BCRYPT_ROUNDS = 12;
export const ADMIN_PASSWORD_COMPLEXITY_PATTERN =
  /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9\s])/;

export const ADMIN_SECURITY_GRANT_BYTES = 32;
export const ADMIN_SECURITY_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ADMIN_SECURITY_GRANT_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const ADMIN_RECOVERY_GRANT_PUBLIC_ID_PATTERN =
  /^argr_[A-Za-z0-9_-]{24}$/;
export const ADMIN_RECOVERY_GRANT_TTL_SECONDS = 900;

export const ADMIN_BREAK_GLASS_CONFIRMATION_ENV =
  'ADMIN_BREAK_GLASS_EXECUTION_CONFIRMATION' as const;
export const ADMIN_BREAK_GLASS_CONFIRMATION_VALUE = 'YES' as const;

export enum AdminRecoveryPurpose {
  ADMIN_MFA_RESET = 'admin_mfa_reset',
  SUPER_ADMIN_BREAK_GLASS = 'super_admin_break_glass',
}
