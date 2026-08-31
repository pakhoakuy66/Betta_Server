import { type Types } from 'mongoose';
import { type AdminAuditSource } from '../constants/admin-audit.constants';
import { type AdminSecurityActor } from './admin-account-recovery.interface';

export type AdminAccessSupportContactActor = AdminSecurityActor &
  Readonly<{
    adminAccountId: Types.ObjectId;
    sessionPublicId: string;
    credentialVersion: number;
    authzVersion: number;
  }>;

export type IssueAdminAccessSupportContactReauthInput = Readonly<{
  actor: AdminAccessSupportContactActor;
  reportPublicId: string;
  password: string;
  totpToken: string;
  trustedClientIp: string;
  source: AdminAuditSource;
}>;

export type RevealAdminAccessSupportContactInput = Readonly<{
  actor: AdminAccessSupportContactActor;
  reportPublicId: string;
  reauthGrant: string;
  reason: string;
  correlationId?: string;
  source: AdminAuditSource;
}>;

export type PublicAdminAccessSupportContact = Readonly<{
  reportPublicId: string;
  contactEmail: string;
}>;
