export const ADMIN_REAUTH_GRANT_PUBLIC_ID_PATTERN = /^argt_[A-Za-z0-9_-]{24}$/;
export const ADMIN_REAUTH_GRANT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export enum AdminReauthPurpose {
  ADMINS_CREATE = 'admins.create',
  ADMIN_MFA_RESET = 'admins.mfa_reset',
  SUPER_ADMIN_LOCK = 'admins.lock_super_admin',
  SUPER_ADMIN_UNLOCK = 'admins.unlock_super_admin',
  SUPER_ADMIN_DELETE = 'admins.delete_super_admin',
  SUPER_ADMIN_RESTORE = 'admins.restore_super_admin',
  REPORT_CONTACT_REVEAL = 'reports.contact_reveal',
}
