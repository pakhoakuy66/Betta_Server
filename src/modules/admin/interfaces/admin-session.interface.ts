import { type ClientSession, type Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { type AdminAuditActorInput } from './admin-audit.interface';
import { type AdminSessionRevokeReason } from '../constants/admin-session.constants';

export type AdminSessionAccount = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
}>;

export type AdminSessionRequestMetadata = Readonly<{
  userAgent?: string;
}>;

export type AdminRefreshTokenClaims = Readonly<{
  tokenUse: 'admin_refresh';
  sub: string;
  sid: string;
  family: string;
  version: number;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}>;

export type AdminSessionCredential = Readonly<{
  refreshToken: string;
  sessionPublicId: string;
  expiresAt: Date;
}>;

export type AdminSessionRotationResult = Readonly<{
  refreshToken: string;
  sessionPublicId: string;
  expiresAt: Date;
  account: AdminSessionAccount;
}>;

export type PublicAdminSession = Readonly<{
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}>;

export type AdminSessionPage = Readonly<{
  items: readonly PublicAdminSession[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;

export type RevokeAdminSessionsInTransactionInput = Readonly<{
  targetAdminAccountId: Types.ObjectId;
  targetAdminPublicId: string;
  reason: AdminSessionRevokeReason;
  auditActor: AdminAuditActorInput;
  mongoSession: ClientSession;
}>;
