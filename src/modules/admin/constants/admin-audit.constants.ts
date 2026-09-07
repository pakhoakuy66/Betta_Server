export const ADMIN_AUDIT_SCHEMA_VERSION = 1 as const;
export const ADMIN_AUDIT_RETENTION_DAYS = 365 as const;
export const ADMIN_AUDIT_PUBLIC_ID_PATTERN =
  /^aaud_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{16}$/;
export const ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN =
  /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{8,64}$/;
export const ADMIN_AUDIT_REASON_CODE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
export const ADMIN_AUDIT_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,63}$/;
export const ADMIN_AUDIT_TIMELINE_TARGET_PUBLIC_ID =
  'audit_admin_timeline' as const;

export enum AdminAuditActorType {
  ADMIN_ACCOUNT = 'admin_account',
  SYSTEM = 'system',
  DEPLOYMENT_OPERATOR = 'deployment_operator',
}

export enum AdminAuditOutcome {
  SUCCEEDED = 'succeeded',
  DENIED = 'denied',
  FAILED = 'failed',
}

export enum AdminAuditSource {
  HTTP = 'http',
  CLI = 'cli',
  WORKER = 'worker',
  SYSTEM = 'system',
}

export enum AdminAuditTargetType {
  ADMIN_ACCOUNT = 'admin_account',
  ADMIN_SESSION = 'admin_session',
  USER = 'user',
  POST = 'post',
  REPORT = 'report',
  SYSTEM_REPORT = 'system_report',
  SPONSORED_POST = 'sponsored_post',
  REAUTH_GRANT = 'reauth_grant',
  SECURITY_CONTROL = 'security_control',
  AUDIT_LOG = 'audit_log',
}

export enum AdminAuditAction {
  BOOTSTRAP_GRANT_ISSUED = 'admin.bootstrap_grant.issued',
  BOOTSTRAP_GRANT_REISSUED = 'admin.bootstrap_grant.reissued',
  BOOTSTRAP_GRANT_REVOKED = 'admin.bootstrap_grant.revoked',
  ACTIVATION_CONSUMED = 'admin.activation.consumed',
  ADMIN_CREATED = 'admin.account.created',
  ADMIN_LOCKED = 'admin.account.locked',
  ADMIN_UNLOCKED = 'admin.account.unlocked',
  ADMIN_DELETED = 'admin.account.deleted',
  ADMIN_RESTORED = 'admin.account.restored',
  ADMIN_PERMISSIONS_UPDATED = 'admin.permissions.updated',
  LOGIN_SUCCEEDED = 'admin.auth.login_succeeded',
  LOGIN_DENIED = 'admin.auth.login_denied',
  SESSION_CREATED = 'admin.session.created',
  SESSION_ROTATED = 'admin.session.rotated',
  SESSION_REVOKED = 'admin.session.revoked',
  SESSIONS_REVOKED_ALL = 'admin.session.revoked_all',
  REFRESH_REPLAY_DETECTED = 'admin.session.refresh_replay_detected',
  PASSWORD_CHANGED = 'admin.credential.password_changed',
  MFA_ENROLLED = 'admin.mfa.enrolled',
  MFA_RECOVERY_USED = 'admin.mfa.recovery_used',
  MFA_RESET = 'admin.mfa.reset',
  BREAK_GLASS_RECOVERY = 'admin.break_glass.recovery',
  REAUTH_GRANT_ISSUED = 'admin.reauth_grant.issued',
  REAUTH_GRANT_CONSUMED = 'admin.reauth_grant.consumed',
  USER_SUSPENDED = 'moderation.user.suspended',
  USER_UNSUSPENDED = 'moderation.user.unsuspended',
  USER_BANNED = 'moderation.user.banned',
  USER_UNBANNED = 'moderation.user.unbanned',
  USER_DELETED = 'moderation.user.deleted',
  USER_RESTORED = 'moderation.user.restored',
  POST_HIDDEN = 'moderation.post.hidden',
  POST_RESTORED = 'moderation.post.restored',
  POST_DELETED = 'moderation.post.deleted',
  REPORT_CLAIMED = 'moderation.report.claimed',
  REPORT_REASSIGNED = 'moderation.report.reassigned',
  REPORT_RESOLVED = 'moderation.report.resolved',
  REPORT_REJECTED = 'moderation.report.rejected',
  SYSTEM_REPORT_TRANSITIONED = 'moderation.system_report.transitioned',
  SPONSORED_CREATED = 'sponsored.created',
  SPONSORED_SCHEDULED = 'sponsored.scheduled',
  SPONSORED_UPDATED = 'sponsored.updated',
  SPONSORED_DELETED = 'sponsored.deleted',
  SPONSORED_RESTORED = 'sponsored.restored',
  SPONSORED_ACTIVATED = 'sponsored.activated',
  SPONSORED_EXPIRED = 'sponsored.expired',
  SPONSORED_PAUSED = 'sponsored.paused',
  SPONSORED_RESUMED = 'sponsored.resumed',
  CONTACT_REVEALED = 'privacy.contact.revealed',
  SECURITY_REQUEST_DENIED = 'security.request.denied',
  AUDIT_LOG_ACCESSED = 'audit.log.accessed',
}
