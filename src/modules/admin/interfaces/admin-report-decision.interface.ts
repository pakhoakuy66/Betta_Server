import type { Types } from 'mongoose';
import type { AdminRole } from '../constants/admin-account.constants';
import type { AdminPermission } from '../constants/admin-permission.constants';
import type {
  AdminReportDecision,
  AdminReportDecisionFailureStep,
  AdminReportDecisionOutcome,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';
import type { AdminAuditActorInput } from './admin-audit.interface';

export type AdminReportDecisionActor = AdminAuditActorInput &
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

export type UpdateAdminReportDecisionInput = Readonly<{
  actor: AdminReportDecisionActor;
  reportPublicId: string;
  decision: AdminReportDecision;
  targetAction: AdminReportTargetAction;
  expectedReportVersion: number;
  expectedTargetVersion?: number;
  reasonCode: string;
  actionReasonCode?: string;
  publicReasonCode?: string;
  expiresAt?: string;
  reasonNote: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type AdminReportDecisionMutationResult = Readonly<{
  report: Readonly<{
    id: string;
    publicId: string;
    status: 'RESOLVED' | 'REJECTED';
    version: number;
    terminalAt: string;
  }>;
  decision: Readonly<{
    id: string;
    publicId: string;
    targetAction: AdminReportTargetAction;
    outcome: AdminReportDecisionOutcome;
    targetVersion: number | null;
  }>;
}>;

export interface AdminReportDecisionFailureInjector {
  hit(step: AdminReportDecisionFailureStep): void | Promise<void>;
}
