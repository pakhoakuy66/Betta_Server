export const ADMIN_TOTP_SECRET_BYTES = 20;
export const ADMIN_TOTP_ENROLLMENT_TTL_MS = 15 * 60 * 1000;
export const ADMIN_TOTP_ENCRYPTED_PREFIX = 'atotp_v1';
export const ADMIN_TOTP_AAD_DOMAIN = 'betta:admin:totp:v1';
export const ADMIN_RECOVERY_CODE_HASH_DOMAIN = 'betta:admin:mfa-recovery:v1';
export const ADMIN_RECOVERY_CODE_BYTES = 16;
export const ADMIN_RECOVERY_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const ADMIN_TOTP_TOKEN_PATTERN = /^\d{6}$/;

export enum AdminMfaEnrollmentMode {
  INITIAL_ENROLLMENT = 'INITIAL_ENROLLMENT',
  ACTIVE_REENROLLMENT = 'ACTIVE_REENROLLMENT',
}
