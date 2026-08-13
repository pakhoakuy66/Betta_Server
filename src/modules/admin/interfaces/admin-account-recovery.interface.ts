import { type Types } from 'mongoose';
import { type AdminAuditSource } from '../constants/admin-audit.constants';
import { AdminRole } from '../constants/admin-account.constants';
import { type AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import { type AdminAuditActorInput } from './admin-audit.interface';

export const ADMIN_RECOVERY_SECRET_STORE = Symbol(
  'ADMIN_RECOVERY_SECRET_STORE',
);

export type AdminSecurityActor = AdminAuditActorInput &
  Readonly<{
    publicId: string;
    username: string;
    role: AdminRole;
    permissionVersion: number;
  }>;

export type ChangeAdminPasswordInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  currentPassword: string;
  newPassword: string;
  totpToken: string;
  trustedClientIp: string;
  actor: AdminSecurityActor;
  source: AdminAuditSource;
}>;

export type BeginRecoveryCodeEnrollmentInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  password: string;
  recoveryCode: string;
  accountLabel: string;
  trustedClientIp: string;
  source: AdminAuditSource;
}>;

export type ResetAdminMfaInput = Readonly<{
  actorAdminAccountId: Types.ObjectId;
  actor: AdminSecurityActor;
  actorSessionPublicId: string;
  targetAdminPublicId: string;
  reauthGrant: string;
  reasonCode: string;
  source: AdminAuditSource;
}>;

export type BreakGlassRecoveryInput = Readonly<{
  targetAdminPublicId: string;
  operatorReference: string;
  approvalReference: string;
  correlationId?: string;
}>;

export type BeginRecoveryGrantEnrollmentInput = Readonly<{
  targetAdminPublicId: string;
  rawGrant: string;
  purpose: AdminRecoveryPurpose;
  newPassword?: string;
  accountLabel: string;
  trustedClientIp: string;
}>;

export type AdminRecoveryEnrollmentChallenge = Readonly<{
  secretBase32: string;
  otpauthUri: string;
  expiresAt: Date;
  confirmationGrant: string;
}>;

export type ConfirmRecoveryEnrollmentInput = Readonly<{
  targetAdminPublicId: string;
  rawGrant: string;
  token: string;
  trustedClientIp: string;
  source: AdminAuditSource;
}>;

export type AdminRecoveryGrantResult = Readonly<{
  secretReference: string;
  expiresAt: string;
}>;

export type PutAdminRecoverySecretInput = Readonly<{
  secretName: string;
  rawGrant: string;
  expiresAt: Date;
  purpose: AdminRecoveryPurpose;
  targetPublicId: string;
}>;

export interface AdminRecoverySecretStore {
  assertReady(): void;
  putVersion(input: PutAdminRecoverySecretInput): Promise<string>;
  revokeVersion(secretReference: string): Promise<void>;
}
