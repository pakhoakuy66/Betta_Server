import { ACCESS_SUPPORT_CATEGORIES } from '../../reports/constants/access-support.constants';
import {
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import {
  SystemReportStatus,
  SystemReportType,
} from '../../reports/schemas/system-report.schema';

export enum AdminReportQueueType {
  POST = 'POST',
  USER = 'USER',
  SYSTEM_ISSUE = 'SYSTEM_ISSUE',
  ACCOUNT_ACCESS = 'ACCOUNT_ACCESS',
}

export enum AdminReportQueueStatus {
  PENDING = 'PENDING',
  REVIEWING = 'REVIEWING',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export enum AdminReportQueueSlaFilter {
  BREACHED = 'BREACHED',
  ON_TRACK = 'ON_TRACK',
}

export enum AdminReportQueueSort {
  CREATED_AT_DESC = 'CREATED_AT_DESC',
  CREATED_AT_ASC = 'CREATED_AT_ASC',
  TRIAGE_DUE_ASC = 'TRIAGE_DUE_ASC',
  DECISION_DUE_ASC = 'DECISION_DUE_ASC',
}

export const ADMIN_REPORT_QUEUE_UNASSIGNED = 'UNASSIGNED' as const;
export const ADMIN_REPORT_QUEUE_DEFAULT_PAGE = 1;
export const ADMIN_REPORT_QUEUE_DEFAULT_LIMIT = 20;
export const ADMIN_REPORT_QUEUE_MAX_LIMIT = 100;
export const ADMIN_REPORT_QUEUE_MAX_PAGE = 100;
export const ADMIN_REPORT_QUEUE_LIST_ACCESSED_EVENT =
  'security.admin.report_queue.list_accessed';

export const ADMIN_REPORT_QUEUE_REASON_CODES = Object.freeze([
  ...Object.values(ReportReasonGroup),
  ...ACCESS_SUPPORT_CATEGORIES,
  SystemReportType.SYSTEM_ISSUE,
] as const);

export const REPORT_STATUS_TO_ADMIN = Object.freeze({
  [ReportStatus.PENDING]: AdminReportQueueStatus.PENDING,
  [ReportStatus.REVIEWING]: AdminReportQueueStatus.REVIEWING,
  [ReportStatus.RESOLVED]: AdminReportQueueStatus.RESOLVED,
  [ReportStatus.REJECTED]: AdminReportQueueStatus.REJECTED,
} satisfies Record<ReportStatus, AdminReportQueueStatus>);

export const SYSTEM_REPORT_STATUS_TO_ADMIN = Object.freeze({
  [SystemReportStatus.PENDING]: AdminReportQueueStatus.PENDING,
  [SystemReportStatus.INVESTIGATING]: AdminReportQueueStatus.REVIEWING,
  [SystemReportStatus.FIXED]: AdminReportQueueStatus.RESOLVED,
  [SystemReportStatus.CLOSED]: AdminReportQueueStatus.REJECTED,
} satisfies Record<SystemReportStatus, AdminReportQueueStatus>);

export const ADMIN_STATUS_TO_REPORT = Object.freeze({
  [AdminReportQueueStatus.PENDING]: ReportStatus.PENDING,
  [AdminReportQueueStatus.REVIEWING]: ReportStatus.REVIEWING,
  [AdminReportQueueStatus.RESOLVED]: ReportStatus.RESOLVED,
  [AdminReportQueueStatus.REJECTED]: ReportStatus.REJECTED,
} satisfies Record<AdminReportQueueStatus, ReportStatus>);

export const ADMIN_STATUS_TO_SYSTEM_REPORT = Object.freeze({
  [AdminReportQueueStatus.PENDING]: SystemReportStatus.PENDING,
  [AdminReportQueueStatus.REVIEWING]: SystemReportStatus.INVESTIGATING,
  [AdminReportQueueStatus.RESOLVED]: SystemReportStatus.FIXED,
  [AdminReportQueueStatus.REJECTED]: SystemReportStatus.CLOSED,
} satisfies Record<AdminReportQueueStatus, SystemReportStatus>);

export const isUserContentQueueType = (
  value: AdminReportQueueType | undefined,
): value is AdminReportQueueType.POST | AdminReportQueueType.USER =>
  value === AdminReportQueueType.POST || value === AdminReportQueueType.USER;

export const toReportTargetType = (
  value: AdminReportQueueType.POST | AdminReportQueueType.USER,
): ReportTargetType =>
  value === AdminReportQueueType.POST
    ? ReportTargetType.POST
    : ReportTargetType.USER;

export const isSystemQueueType = (
  value: AdminReportQueueType | undefined,
): value is
  | AdminReportQueueType.SYSTEM_ISSUE
  | AdminReportQueueType.ACCOUNT_ACCESS =>
  value === AdminReportQueueType.SYSTEM_ISSUE ||
  value === AdminReportQueueType.ACCOUNT_ACCESS;

export const toSystemReportType = (
  value:
    | AdminReportQueueType.SYSTEM_ISSUE
    | AdminReportQueueType.ACCOUNT_ACCESS,
): SystemReportType =>
  value === AdminReportQueueType.ACCOUNT_ACCESS
    ? SystemReportType.ACCOUNT_ACCESS
    : SystemReportType.SYSTEM_ISSUE;
