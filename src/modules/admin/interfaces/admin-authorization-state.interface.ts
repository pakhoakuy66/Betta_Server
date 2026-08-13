import { type AdminRole } from '../constants/admin-account.constants';

export type ResolveAdminAuthorizationInput = Readonly<{
  adminPublicId: string;
  sessionPublicId: string;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
}>;

export type AdminAuthorizationAccountState = Readonly<{
  adminAccountId: string;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
}>;
