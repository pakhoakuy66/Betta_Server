import {
  CanonicalModerationReasonCode,
  PublicModerationReasonCode,
} from '../../../common/moderation/moderation-reason.constants';
import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export enum AdminReportDecision {
  RESOLVE = 'RESOLVE',
  REJECT = 'REJECT',
}

export enum AdminReportTargetAction {
  NONE = 'NONE',
  POST_HIDE = 'POST_HIDE',
  POST_TERMINAL_DELETE = 'POST_TERMINAL_DELETE',
  USER_TEMPORARY_SUSPENSION = 'USER_TEMPORARY_SUSPENSION',
  USER_INDEFINITE_BAN = 'USER_INDEFINITE_BAN',
}

export enum AdminReportDecisionOutcome {
  ACTION_APPLIED = 'ACTION_APPLIED',
  REPORT_REJECTED = 'REPORT_REJECTED',
  TARGET_EXPIRED_NO_ACTION = 'TARGET_EXPIRED_NO_ACTION',
  TARGET_DELETED_NO_ACTION = 'TARGET_DELETED_NO_ACTION',
  TARGET_UNAVAILABLE_NO_ACTION = 'TARGET_UNAVAILABLE_NO_ACTION',
}

export enum AdminReportDecisionFailureStep {
  AFTER_TARGET = 'AFTER_TARGET',
  AFTER_REPORT = 'AFTER_REPORT',
  AFTER_HISTORY = 'AFTER_HISTORY',
  AFTER_AUDIT = 'AFTER_AUDIT',
  AFTER_OUTBOX = 'AFTER_OUTBOX',
  AFTER_REQUEST = 'AFTER_REQUEST',
}

export const ADMIN_REPORT_DECISIONS = Object.freeze(
  Object.values(AdminReportDecision),
);
export const ADMIN_REPORT_TARGET_ACTIONS = Object.freeze(
  Object.values(AdminReportTargetAction),
);
export const ADMIN_REPORT_DECISION_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
  CanonicalModerationReasonCode.INSUFFICIENT_EVIDENCE,
  CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
  CanonicalModerationReasonCode.TARGET_DELETED_NO_ACTION,
  CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION,
]);
export const ADMIN_REPORT_DECISION_ACTION_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.MODERATION_POLICY,
  CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
]);
export const ADMIN_REPORT_DECISION_PUBLIC_REASON_CODES = Object.freeze([
  PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
  PublicModerationReasonCode.SEVERE_POLICY_VIOLATION,
  PublicModerationReasonCode.CONTENT_VISIBILITY_UPDATED,
]);

export const ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH = 500 as const;
export const ADMIN_REPORT_DECISION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export enum AdminReportDecisionRequestState {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

export const ADMIN_REPORT_DECISION_REPLAY_WAIT_DELAYS_MS = Object.freeze([
  10, 20, 40, 80, 120, 180,
]);
export const ADMIN_REPORT_DECISION_EVENT_TYPE =
  'moderation.report.decided' as const;
export const ADMIN_REPORT_DECISION_AGGREGATE_TYPE = 'report' as const;
export const ADMIN_POST_MODERATION_EVENT_TYPE =
  'moderation.post.state_changed' as const;
export const ADMIN_POST_MODERATION_AGGREGATE_TYPE = 'post' as const;
export const ADMIN_REPORT_DECISION_FAILURE_INJECTOR = Symbol(
  'ADMIN_REPORT_DECISION_FAILURE_INJECTOR',
);

export const getAdminReportTargetPermission = (
  action: AdminReportTargetAction,
): AdminPermissionValue | undefined => {
  switch (action) {
    case AdminReportTargetAction.POST_HIDE:
      return AdminPermission.POSTS_HIDE;
    case AdminReportTargetAction.POST_TERMINAL_DELETE:
      return AdminPermission.POSTS_DELETE;
    case AdminReportTargetAction.USER_TEMPORARY_SUSPENSION:
      return AdminPermission.USERS_SUSPEND;
    case AdminReportTargetAction.USER_INDEFINITE_BAN:
      return AdminPermission.USERS_BAN;
    default:
      return undefined;
  }
};
