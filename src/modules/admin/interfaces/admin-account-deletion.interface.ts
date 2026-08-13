import { type Types } from 'mongoose';
import {
  type AdminAccountDeletionOrigin,
  type AdminAccountStatus,
  type AdminRole,
} from '../constants/admin-account.constants';
import { type AdminAccountDeletionAction } from '../constants/admin-account-deletion.constants';
import { type AdminPermission } from '../constants/admin-permission.constants';
import { type AdminAuditActorInput } from './admin-audit.interface';

export type AdminAccountDeletionActor = AdminAuditActorInput &
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

export type IssueSuperAdminDeletionReauthInput = Readonly<{
  actor: AdminAccountDeletionActor;
  targetPublicId: string;
  action: AdminAccountDeletionAction;
  password: string;
  totpToken: string;
  trustedClientIp: string;
}>;

export type UpdateAdminAccountDeletionInput = Readonly<{
  actor: AdminAccountDeletionActor;
  targetPublicId: string;
  action: AdminAccountDeletionAction;
  expectedVersion: number;
  reasonCode: string;
  reasonNote: string;
  correlationId?: string;
  reauthGrant?: string;
}>;

export type AdminAccountDeletionMutationResult = Readonly<{
  admin: Readonly<{
    id: string;
    publicId: string;
    status: AdminAccountStatus;
    version: number;
    deletionOrigin: AdminAccountDeletionOrigin | null;
    deletedAt: string | null;
    lockedAt: string | null;
    updatedAt: string;
  }>;
  revokedSessionCount: number;
}>;
