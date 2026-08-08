import { ADMIN_ACCESS_TOKEN_USE } from '../constants/admin-auth-token.constants';

export interface AdminAccessTokenClaims {
  tokenUse: typeof ADMIN_ACCESS_TOKEN_USE;
  sub: string;
  sid: string;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface IssueAdminAccessTokenInput {
  adminPublicId: string;
  sessionPublicId: string;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
}
