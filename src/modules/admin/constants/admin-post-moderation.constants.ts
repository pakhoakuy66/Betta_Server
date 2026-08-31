import {
  CanonicalModerationReasonCode,
  ModerationReasonAction,
} from '../../../common/moderation/moderation-reason.constants';
import {
  AdminPermission,
  type AdminPermission as AdminPermissionValue,
} from './admin-permission.constants';

export enum AdminPostModerationOperation {
  HIDE = 'HIDE',
  RESTORE = 'RESTORE',
  TERMINAL_DELETE = 'TERMINAL_DELETE',
}

export enum AdminPostModerationRequestState {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

export enum AdminPostModerationFailureStep {
  AFTER_RESERVATION = 'AFTER_RESERVATION',
  AFTER_TARGET = 'AFTER_TARGET',
  AFTER_OUTBOX = 'AFTER_OUTBOX',
  AFTER_AUDIT = 'AFTER_AUDIT',
  AFTER_REQUEST = 'AFTER_REQUEST',
}

export const ADMIN_POST_HIDE_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.MODERATION_POLICY,
]);
export const ADMIN_POST_RESTORE_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
]);
export const ADMIN_POST_TERMINAL_DELETE_REASON_CODES = Object.freeze([
  CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
]);

export const ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH = 3;
export const ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH = 500;
export const ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const ADMIN_POST_MODERATION_IDEMPOTENCY_INDEX =
  'admin_post_moderation_idempotency_unique_v1' as const;
export const ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_INDEX =
  'admin_post_moderation_idempotency_expiry_ttl_v1' as const;
export const ADMIN_POST_MODERATION_REPLAY_WAIT_DELAYS_MS = Object.freeze([
  10, 20, 40, 80, 120, 180,
]);
export const ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,79}$/;
export const ADMIN_POST_MODERATION_EVENT_TYPE =
  'moderation.post.state_changed' as const;
export const ADMIN_POST_MODERATION_AGGREGATE_TYPE = 'post' as const;
export const ADMIN_POST_MODERATION_FAILURE_INJECTOR = Symbol(
  'ADMIN_POST_MODERATION_FAILURE_INJECTOR',
);

export const getAdminPostModerationPermission = (
  operation: AdminPostModerationOperation,
): AdminPermissionValue => {
  switch (operation) {
    case AdminPostModerationOperation.HIDE:
      return AdminPermission.POSTS_HIDE;
    case AdminPostModerationOperation.RESTORE:
      return AdminPermission.POSTS_RESTORE;
    case AdminPostModerationOperation.TERMINAL_DELETE:
      return AdminPermission.POSTS_DELETE;
  }
};

export const getAdminPostModerationReasonAction = (
  operation: AdminPostModerationOperation,
): ModerationReasonAction => {
  switch (operation) {
    case AdminPostModerationOperation.HIDE:
      return ModerationReasonAction.HIDE;
    case AdminPostModerationOperation.RESTORE:
      return ModerationReasonAction.RESTORE;
    case AdminPostModerationOperation.TERMINAL_DELETE:
      return ModerationReasonAction.TERMINAL_DELETE;
  }
};
