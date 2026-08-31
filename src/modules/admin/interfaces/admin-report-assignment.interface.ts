import type { PublicReportAssignmentConflictState } from '../../../common/security/public-report-assignment-conflict';
import type { AdminReportQueueStatus } from '../constants/admin-report-queue.constants';
import type { Types } from 'mongoose';
import type { AdminRole } from '../constants/admin-account.constants';
import type { AdminPermission } from '../constants/admin-permission.constants';
import type {
  AdminReportAssignmentKind,
  AdminReportAssignmentOperation,
} from '../constants/admin-report-assignment.constants';
import type { AdminAuditActorInput } from './admin-audit.interface';

export type AdminReportAssignmentCurrentState =
  PublicReportAssignmentConflictState;

export type AdminReportAssignmentActor = AdminAuditActorInput &
  Readonly<{
    adminAccountId: Types.ObjectId;
    publicId: string;
    username: string;
    displayName: string;
    role: AdminRole;
    permission: AdminPermission;
    permissionVersion: number;
    sessionPublicId: string;
    credentialVersion: number;
    authzVersion: number;
  }>;

export type UpdateAdminReportAssignmentInput = Readonly<{
  actor: AdminReportAssignmentActor;
  reportPublicId: string;
  operation: AdminReportAssignmentOperation;
  expectedVersion: number;
  assigneePublicId?: string;
  adminNote?: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type AdminReportAssignmentMutationResult = Readonly<{
  report: Readonly<{
    id: string;
    publicId: string;
    kind: AdminReportAssignmentKind;
    status: AdminReportQueueStatus;
    assignee: Readonly<{
      publicId: string;
      assignedAt: string;
    }>;
    version: number;
    updatedAt: string;
  }>;
}>;
