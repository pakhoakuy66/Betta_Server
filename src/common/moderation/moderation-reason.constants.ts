export const MODERATION_REASON_TAXONOMY_VERSION = 1 as const;

export enum ModerationReasonTarget {
  REPORT_POST = 'REPORT_POST',
  REPORT_USER = 'REPORT_USER',
  USER_RESTRICTION = 'USER_RESTRICTION',
  POST = 'POST',
  REPORT = 'REPORT',
}

export enum ModerationReasonAction {
  SUBMIT = 'SUBMIT',
  APPLY_TEMPORARY_SUSPENSION = 'APPLY_TEMPORARY_SUSPENSION',
  APPLY_INDEFINITE_BAN = 'APPLY_INDEFINITE_BAN',
  REMOVE_TEMPORARY_SUSPENSION = 'REMOVE_TEMPORARY_SUSPENSION',
  REMOVE_INDEFINITE_BAN = 'REMOVE_INDEFINITE_BAN',
  EXPIRE_TEMPORARY_SUSPENSION = 'EXPIRE_TEMPORARY_SUSPENSION',
  HIDE = 'HIDE',
  RESTORE = 'RESTORE',
  TERMINAL_DELETE = 'TERMINAL_DELETE',
  RESOLVE = 'RESOLVE',
  REJECT = 'REJECT',
  CLOSE_NO_ACTION = 'CLOSE_NO_ACTION',
}

export enum CanonicalModerationReasonCode {
  VIOLENCE_HATE = 'violence_hate',
  NUDITY_SEXUAL = 'nudity_sexual',
  SCAM_FRAUD = 'scam_fraud',
  MISINFORMATION = 'misinformation',
  IMPERSONATION_ME = 'me',
  IMPERSONATION_FOLLOWED_PERSON = 'followed_person',
  IMPERSONATION_PUBLIC_FIGURE = 'public_figure',
  IMPERSONATION_BUSINESS_ORGANIZATION = 'business_organization',
  MODERATION_POLICY = 'moderation_policy',
  SEVERE_POLICY_VIOLATION = 'severe_policy_violation',
  MODERATION_REVIEW_COMPLETED = 'moderation_review_completed',
  RESTRICTION_EXPIRED = 'restriction_expired',
  EVIDENCE_CONFIRMED = 'evidence_confirmed',
  INSUFFICIENT_EVIDENCE = 'insufficient_evidence',
  TARGET_EXPIRED_NO_ACTION = 'target_expired_no_action',
  TARGET_DELETED_NO_ACTION = 'target_deleted_no_action',
  TARGET_MISSING_NO_ACTION = 'target_missing_no_action',
}

export enum PublicModerationReasonCode {
  COMMUNITY_POLICY_REVIEW = 'community_policy_review',
  SEVERE_POLICY_VIOLATION = 'severe_policy_violation',
  ACCOUNT_ACCESS_RESTORED = 'account_access_restored',
  CONTENT_VISIBILITY_UPDATED = 'content_visibility_updated',
  REPORT_REVIEW_COMPLETED = 'report_review_completed',
}

export const REPORT_POST_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.VIOLENCE_HATE,
  CanonicalModerationReasonCode.NUDITY_SEXUAL,
  CanonicalModerationReasonCode.SCAM_FRAUD,
  CanonicalModerationReasonCode.MISINFORMATION,
]);

export const REPORT_USER_REASON_CODES = Object.freeze([
  ...REPORT_POST_REASON_CODES,
  CanonicalModerationReasonCode.IMPERSONATION_ME,
  CanonicalModerationReasonCode.IMPERSONATION_FOLLOWED_PERSON,
  CanonicalModerationReasonCode.IMPERSONATION_PUBLIC_FIGURE,
  CanonicalModerationReasonCode.IMPERSONATION_BUSINESS_ORGANIZATION,
]);

export const REPORT_REASON_CODES = REPORT_USER_REASON_CODES;
export const MODERATION_REASON_DETAIL_MIN_LENGTH = 3 as const;
export const MODERATION_REASON_DETAIL_MAX_LENGTH = 500 as const;
export const MODERATION_REASON_UNSAFE_MARKUP_PATTERN =
  /<[^>]*>|&lt;\/?[a-z][^&]*&gt;|javascript\s*:|data\s*:\s*text\/html/iu;
export const MODERATION_REASON_UNSAFE_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex -- Intentionally detects unsafe control characters.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
