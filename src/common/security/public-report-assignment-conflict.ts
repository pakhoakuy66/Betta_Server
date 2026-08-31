export const REPORT_ASSIGNMENT_CONFLICT_ERROR =
  'REPORT_ASSIGNMENT_CONFLICT' as const;
export const REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT_ERROR =
  'REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT' as const;

export type PublicReportAssignmentConflictState = Readonly<{
  publicId: string;
  kind: 'REPORT' | 'SYSTEM_REPORT';
  status: 'PENDING' | 'REVIEWING' | 'RESOLVED' | 'REJECTED';
  assignee: Readonly<{
    publicId: string | null;
    assignedAt: string | null;
  }>;
  version: number;
}>;

const REPORT_PUBLIC_ID_PATTERN = /^(?:rpt|srep)_[A-Za-z0-9_-]{8,64}$/u;
const ADMIN_PUBLIC_ID_PATTERN = /^adm_[A-Za-z0-9_-]{8,64}$/u;
const ALLOWED_KINDS = new Set(['REPORT', 'SYSTEM_REPORT']);
const ALLOWED_STATUSES = new Set([
  'PENDING',
  'REVIEWING',
  'RESOLVED',
  'REJECTED',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isCanonicalIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export const normalizePublicReportAssignmentConflict = (
  value: unknown,
): PublicReportAssignmentConflictState | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'publicId',
      'kind',
      'status',
      'assignee',
      'version',
    ]) ||
    typeof value.publicId !== 'string' ||
    !REPORT_PUBLIC_ID_PATTERN.test(value.publicId) ||
    typeof value.kind !== 'string' ||
    !ALLOWED_KINDS.has(value.kind) ||
    typeof value.status !== 'string' ||
    !ALLOWED_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !isRecord(value.assignee) ||
    !hasOnlyKeys(value.assignee, ['publicId', 'assignedAt'])
  ) {
    return undefined;
  }

  const assigneePublicId = value.assignee.publicId;
  const assignedAt = value.assignee.assignedAt;
  const isUnassigned = assigneePublicId === null && assignedAt === null;
  const isAssigned =
    typeof assigneePublicId === 'string' &&
    ADMIN_PUBLIC_ID_PATTERN.test(assigneePublicId) &&
    isCanonicalIsoDate(assignedAt);
  if (!isUnassigned && !isAssigned) return undefined;

  return Object.freeze({
    publicId: value.publicId,
    kind: value.kind as PublicReportAssignmentConflictState['kind'],
    status: value.status as PublicReportAssignmentConflictState['status'],
    assignee: Object.freeze({
      publicId: assigneePublicId,
      assignedAt,
    }),
    version: value.version as number,
  });
};
