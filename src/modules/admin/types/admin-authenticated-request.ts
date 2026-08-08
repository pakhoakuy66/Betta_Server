import { type Request } from 'express';
import { AdminRole } from '../constants/admin-account.constants';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';

export interface AdminRequestPrincipal {
  /** Chỉ dùng nội bộ Backend; không đưa vào response. */
  adminAccountId: string;
  id: string;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
}

export type AdminAuthenticatedRequest = Request & {
  user: AdminRequestPrincipal;
};

const INTERNAL_OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const isAdminRequestPrincipal = (
  value: unknown,
): value is AdminRequestPrincipal => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const principal = value as Record<string, unknown>;

  return (
    typeof principal.adminAccountId === 'string' &&
    INTERNAL_OBJECT_ID_PATTERN.test(principal.adminAccountId) &&
    isValidAdminPublicId(principal.id) &&
    principal.id === principal.publicId &&
    typeof principal.username === 'string' &&
    principal.username.length > 0 &&
    typeof principal.displayName === 'string' &&
    principal.displayName.length > 0 &&
    (principal.role === AdminRole.ADMIN ||
      principal.role === AdminRole.SUPER_ADMIN) &&
    typeof principal.sessionId === 'string' &&
    ADMIN_SESSION_PUBLIC_ID_PATTERN.test(principal.sessionId) &&
    isNonNegativeInteger(principal.credentialVersion) &&
    isNonNegativeInteger(principal.authzVersion) &&
    isNonNegativeInteger(principal.permissionVersion)
  );
};
