import type { Types } from 'mongoose';
import type { PublicUserRestriction } from '../../users/utils/user-restriction';
import type { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import type { AdminRole } from '../constants/admin-account.constants';
import type { AdminPermission } from '../constants/admin-permission.constants';
import type { AdminUserRestrictionOperation } from '../constants/admin-user-restriction.constants';
import type { AdminAuditActorInput } from './admin-audit.interface';

export type AdminUserRestrictionActor = AdminAuditActorInput &
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

export type UpdateAdminUserRestrictionInput = Readonly<{
  actor: AdminUserRestrictionActor;
  targetPublicId: string;
  operation: AdminUserRestrictionOperation;
  restrictionType: UserRestrictionType;
  expectedVersion: number;
  expiresAt?: string;
  publicReasonCode?: string;
  reasonCode: string;
  reasonNote: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type AdminUserRestrictionMutationResult = Readonly<{
  user: Readonly<{
    id: string;
    publicId: string;
    version: number;
    restriction: PublicUserRestriction | null;
    updatedAt: string;
  }>;
  revokedSessionCount: number;
}>;
