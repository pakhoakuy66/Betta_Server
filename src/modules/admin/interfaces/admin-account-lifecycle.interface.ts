import { type Types } from 'mongoose';
import { type PublicAdminAccount } from '../mappers/admin-account-public.mapper';
import { type AdminSecurityActor } from './admin-account-recovery.interface';

export type AdminLifecycleActor = AdminSecurityActor &
  Readonly<{
    adminAccountId: Types.ObjectId;
    sessionPublicId: string;
    credentialVersion: number;
    authzVersion: number;
  }>;

export type IssueCreateAdminReauthInput = Readonly<{
  actor: AdminLifecycleActor;
  password: string;
  totpToken: string;
  trustedClientIp: string;
}>;

export type CreateAdminAccountInput = Readonly<{
  actor: AdminLifecycleActor;
  email: string;
  username: string;
  displayName: string;
  reauthGrant: string;
  reasonCode: string;
  reasonNote?: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type CreateAdminAccountResult = Readonly<{
  admin: PublicAdminAccount;
  activation: Readonly<{
    secretReference: string;
    expiresAt: string;
  }>;
}>;
