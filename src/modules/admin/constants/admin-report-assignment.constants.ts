import { ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/access-support.constants';
import { REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/report-queue.constants';

export enum AdminReportAssignmentOperation {
  CLAIM = 'CLAIM',
  REASSIGN = 'REASSIGN',
}

export enum AdminReportAssignmentKind {
  REPORT = 'REPORT',
  SYSTEM_REPORT = 'SYSTEM_REPORT',
}

export const ADMIN_REPORT_ASSIGNMENT_OPERATIONS = Object.freeze(
  Object.values(AdminReportAssignmentOperation),
);

export const ADMIN_REPORT_PUBLIC_ID_PATTERN = new RegExp(
  `(?:${REPORT_PUBLIC_ID_PATTERN.source}|${ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN.source})`,
);

export const ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH = 3 as const;
export const ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH = 500 as const;
export const ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export const ADMIN_REPORT_CLAIM_REASON_CODE = 'report_claimed' as const;
export const ADMIN_REPORT_REASSIGN_REASON_CODE = 'report_reassigned' as const;

export enum AdminReportAssignmentRequestState {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}
export const ADMIN_REPORT_ASSIGNMENT_REPLAY_WAIT_DELAYS_MS = Object.freeze([
  10, 20, 40, 80, 120, 180,
]);
