export const ADMIN_SESSION_COLLECTION = 'admin_sessions';
export const ADMIN_SESSION_PUBLIC_ID_INDEX = 'admin_sessions_public_id_unique';
export const ADMIN_SESSION_FAMILY_INDEX = 'admin_sessions_token_family_unique';
export const ADMIN_SESSION_TTL_INDEX = 'admin_sessions_expires_at_ttl';
export const ADMIN_SESSION_OWNER_LIST_INDEX =
  'admin_sessions_owner_active_last_used_public_id';

export const ADMIN_REFRESH_HASH_PREFIX = 'sha256-v1:';

export enum AdminSessionRevokeReason {
  LOGOUT = 'logout',
  LOGOUT_ALL = 'logout_all',
  SESSION_REVOKED = 'session_revoked',
  REFRESH_REPLAY = 'refresh_replay',
  ACCOUNT_LOCKED = 'account_locked',
  ACCOUNT_DELETED = 'account_deleted',
  ACCOUNT_INELIGIBLE = 'account_ineligible',
  PASSWORD_CHANGED = 'password_changed',
  MFA_RESET = 'mfa_reset',
  AUTHORIZATION_CHANGED = 'authorization_changed',
}
