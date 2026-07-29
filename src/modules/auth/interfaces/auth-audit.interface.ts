import type { ClientSession, Types } from 'mongoose';

export enum AuthAuditEventCode {
  ACCOUNT_LOCKED = 'auth.account_locked',
  PASSWORD_CHANGED = 'auth.password_changed',
  PASSWORD_RESET = 'auth.password_reset',
  SESSION_REVOKED = 'auth.session_revoked',
  SESSIONS_REVOKED_ALL = 'auth.sessions_revoked_all',
  ACCOUNT_DELETED = 'auth.account_deleted',
  REFRESH_REPLAY_DETECTED = 'auth.refresh_replay_detected',
  OAUTH_LINKED = 'auth.oauth_linked',
  OAUTH_UNLINKED = 'auth.oauth_unlinked',
}

export enum AuthAuditOutcome {
  SUCCEEDED = 'succeeded',
  DENIED = 'denied',
}

export enum AuthAuditReasonCode {
  LOGIN_FAILURE_THRESHOLD = 'login_failure_threshold',
  PASSWORD_CHANGE_COMPLETED = 'password_change_completed',
  PASSWORD_RESET_COMPLETED = 'password_reset_completed',
  SESSION_REVOKE_REQUESTED = 'session_revoke_requested',
  LOGOUT_ALL_REQUESTED = 'logout_all_requested',
  ACCOUNT_DELETION_COMPLETED = 'account_deletion_completed',
  REFRESH_TOKEN_REPLAY = 'refresh_token_replay',
  OAUTH_ACCOUNT_LINKED = 'oauth_account_linked',
  OAUTH_ACCOUNT_UNLINKED = 'oauth_account_unlinked',
}

export enum AuthAuditProvider {
  GOOGLE = 'google',
}

export type AuthAuditMetadata = {
  affectedSessionCount?: number;
  provider?: AuthAuditProvider;
};

export type RecordAuthAuditInput = {
  eventCode: AuthAuditEventCode;
  outcome: AuthAuditOutcome;
  reasonCode: AuthAuditReasonCode;
  targetUserId: Types.ObjectId;
  actorUserId?: Types.ObjectId | null;
  sessionPublicId?: string;
  metadata?: AuthAuditMetadata;
  mongoSession?: ClientSession;
};
