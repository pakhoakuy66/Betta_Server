import { type Types } from 'mongoose';
import {
  type AdminAccountStatus,
  type AdminRole,
} from '../constants/admin-account.constants';
import { type AdminPermission } from '../constants/admin-permission.constants';
import { type AdminAuditActorInput } from './admin-audit.interface';

export type AdminAccountStatusActor = AdminAuditActorInput &
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

export type IssueSuperAdminStatusReauthInput = Readonly<{
  actor: AdminAccountStatusActor;
  targetPublicId: string;
  status: AdminAccountStatus;
  password: string;
  totpToken: string;
  trustedClientIp: string;
}>;

export type UpdateAdminAccountStatusInput = Readonly<{
  actor: AdminAccountStatusActor;
  targetPublicId: string;
  status: AdminAccountStatus;
  expectedVersion: number;
  reasonCode: string;
  reasonNote: string;
  correlationId?: string;
  reauthGrant?: string;
}>;

export type AdminAccountStatusMutationResult = Readonly<{
  admin: Readonly<{
    id: string;
    publicId: string;
    status: AdminAccountStatus;
    version: number;
    lockedAt: string | null;
    updatedAt: string;
  }>;
  revokedSessionCount: number;
}>;
