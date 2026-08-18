import type { Types } from 'mongoose';
import type { UserDeletionOrigin } from '../../users/constants/user-moderation.constants';
import type { AdminRole } from '../constants/admin-account.constants';
import type { AdminPermission } from '../constants/admin-permission.constants';
import type { AdminUserDeletionOperation } from '../constants/admin-user-deletion.constants';
import type { AdminAuditActorInput } from './admin-audit.interface';

export type AdminUserDeletionActor = AdminAuditActorInput &
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

export type UpdateAdminUserDeletionInput = Readonly<{
  actor: AdminUserDeletionActor;
  targetPublicId: string;
  operation: AdminUserDeletionOperation;
  expectedVersion: number;
  reasonCode: string;
  reasonNote: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type PublicAdminUserDeletion = Readonly<{
  isDeleted: boolean;
  origin: UserDeletionOrigin | null;
  deletedAt: string | null;
  restorableUntil: string | null;
}>;

export type AdminUserDeletionMutationResult = Readonly<{
  user: Readonly<{
    id: string;
    publicId: string;
    version: number;
    deletion: PublicAdminUserDeletion;
    updatedAt: string;
  }>;
  revokedSessionCount: number;
}>;
