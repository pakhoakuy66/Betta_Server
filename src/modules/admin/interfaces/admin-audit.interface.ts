import { type ClientSession } from 'mongoose';
import { type AdminPermission } from '../constants/admin-permission.constants';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';

export type AdminAuditActorInput = Readonly<{
  type: AdminAuditActorType;
  publicId?: string;
  username?: string;
  displayName: string;
  role?: AdminRole;
  permission?: AdminPermission;
  permissionVersion?: number;
}>;

export type AdminAuditTargetInput = Readonly<{
  type: AdminAuditTargetType;
  publicId: string;
  displayName?: string;
}>;

export type AdminAuditMetadataInput = Readonly<{
  beforeVersion?: number;
  afterVersion?: number;
  beforeState?: string;
  afterState?: string;
  affectedSessionCount?: number;
  beforeAssigneePublicId?: string;
  afterAssigneePublicId?: string;
}>;

export type RecordAdminAuditInput = Readonly<{
  action: AdminAuditAction;
  outcome: AdminAuditOutcome;
  actor: AdminAuditActorInput;
  target: AdminAuditTargetInput;
  reasonCode: string;
  reasonNote?: string;
  metadata?: AdminAuditMetadataInput;
  correlationId?: string;
  source: AdminAuditSource;
  mongoSession?: ClientSession;
}>;

export type AdminAuditQuery = Readonly<{
  page: number;
  limit: number;
  actorPublicId?: string;
  action?: AdminAuditAction;
  targetType?: AdminAuditTargetType;
  targetPublicId?: string;
  outcome?: AdminAuditOutcome;
  from?: Date;
  to?: Date;
}>;

export type PublicAdminAuditEvent = Readonly<{
  id: string;
  schemaVersion: number;
  action: AdminAuditAction;
  outcome: AdminAuditOutcome;
  actor: Readonly<{
    type: AdminAuditActorType;
    publicId?: string;
    username?: string;
    displayName: string;
    role?: AdminRole;
    permission?: AdminPermission;
    permissionVersion?: number;
  }>;
  target: Readonly<{
    type: AdminAuditTargetType;
    publicId: string;
    displayName?: string;
  }>;
  reasonCode: string;
  reasonNote?: string;
  metadata?: AdminAuditMetadataInput;
  correlationId?: string;
  source: AdminAuditSource;
  occurredAt: string;
}>;

export type AdminAuditPage = Readonly<{
  items: readonly PublicAdminAuditEvent[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
