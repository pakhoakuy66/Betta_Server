export enum ReportQueuePriority {
  P0 = 'P0',
  STANDARD = 'STANDARD',
}

export const REPORT_QUEUE_STANDARD_TRIAGE_MS = 24 * 60 * 60 * 1_000;
export const REPORT_QUEUE_P0_TRIAGE_MS = 4 * 60 * 60 * 1_000;
export const REPORT_QUEUE_STANDARD_DECISION_MS = 72 * 60 * 60 * 1_000;
export const REPORT_QUEUE_P0_DECISION_MS = 24 * 60 * 60 * 1_000;

export const REPORT_PUBLIC_ID_PREFIX = 'rpt_';
export const REPORT_PUBLIC_ID_LENGTH = 16;
export const REPORT_PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const REPORT_PUBLIC_ID_PATTERN = new RegExp(
  `^${REPORT_PUBLIC_ID_PREFIX}[${REPORT_PUBLIC_ID_ALPHABET}]{${REPORT_PUBLIC_ID_LENGTH}}$`,
);

export const ADMIN_REPORT_QUEUE_CREATED_INDEX = 'admin_report_queue_created_v1';
export const ADMIN_REPORT_QUEUE_FILTERED_INDEX =
  'admin_report_queue_filtered_v1';
export const ADMIN_REPORT_QUEUE_ASSIGNEE_INDEX =
  'admin_report_queue_assignee_v1';
export const ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX =
  'admin_report_queue_triage_sla_v1';
export const ADMIN_REPORT_QUEUE_DECISION_SLA_INDEX =
  'admin_report_queue_decision_sla_v1';

export const ADMIN_SYSTEM_REPORT_QUEUE_CREATED_INDEX =
  'admin_system_report_queue_created_v1';
export const ADMIN_SYSTEM_REPORT_QUEUE_FILTERED_INDEX =
  'admin_system_report_queue_filtered_v1';
export const ADMIN_SYSTEM_REPORT_QUEUE_ASSIGNEE_INDEX =
  'admin_system_report_queue_assignee_v1';
export const ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SLA_INDEX =
  'admin_system_report_queue_triage_sla_v1';
export const ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SLA_INDEX =
  'admin_system_report_queue_decision_sla_v1';

export const ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX =
  'admin_report_queue_triage_sort_v1';
export const ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX =
  'admin_report_queue_decision_sort_v1';

export const ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX =
  'admin_system_report_queue_triage_sort_v1';
export const ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX =
  'admin_system_report_queue_decision_sort_v1';

export type ReportQueueMetadata = Readonly<{
  priority: ReportQueuePriority;
  triageDueAt: Date;
  decisionDueAt: Date;
}>;

export const buildReportQueueMetadata = (
  createdAt: Date,
  priority: ReportQueuePriority = ReportQueuePriority.STANDARD,
): ReportQueueMetadata => {
  const origin = createdAt.getTime();
  const p0 = priority === ReportQueuePriority.P0;
  return Object.freeze({
    priority,
    triageDueAt: new Date(
      origin +
        (p0 ? REPORT_QUEUE_P0_TRIAGE_MS : REPORT_QUEUE_STANDARD_TRIAGE_MS),
    ),
    decisionDueAt: new Date(
      origin +
        (p0 ? REPORT_QUEUE_P0_DECISION_MS : REPORT_QUEUE_STANDARD_DECISION_MS),
    ),
  });
};
