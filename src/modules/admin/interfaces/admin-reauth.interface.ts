import { type ClientSession, type Types } from 'mongoose';
import { type AdminAuditSource } from '../constants/admin-audit.constants';
import { type AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { type AdminSecurityActor } from './admin-account-recovery.interface';

export type IssueAdminReauthGrantInput = Readonly<{
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  sessionPublicId: string;
  password: string;
  totpToken: string;
  purpose: AdminReauthPurpose;
  targetPublicId: string;
  trustedClientIp: string;
  actor: AdminSecurityActor;
  source: AdminAuditSource;
}>;

export type AdminReauthGrantResult = Readonly<{
  grant: string;
  expiresAt: Date;
}>;

export type ConsumeAdminReauthGrantInput = Readonly<{
  rawGrant: string;
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  sessionPublicId: string;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
  purpose: AdminReauthPurpose;
  targetPublicId: string;
  actor: AdminSecurityActor;
  source: AdminAuditSource;
  mongoSession: ClientSession;
}>;
