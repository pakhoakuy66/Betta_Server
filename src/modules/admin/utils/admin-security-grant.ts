import { createHash, randomBytes } from 'node:crypto';
import {
  ADMIN_SECURITY_GRANT_BYTES,
  ADMIN_SECURITY_GRANT_PATTERN,
  AdminRecoveryPurpose,
} from '../constants/admin-account-recovery.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { isValidAdminPublicId } from './generate-admin-public-id';

const RECOVERY_DOMAIN = 'betta:admin:recovery-grant:v1';
const REAUTH_DOMAIN = 'betta:admin:reauth-grant:v1';

export const generateAdminSecurityGrant = (): string =>
  randomBytes(ADMIN_SECURITY_GRANT_BYTES).toString('base64url');

export const isCanonicalAdminSecurityGrant = (
  value: unknown,
): value is string =>
  typeof value === 'string' &&
  ADMIN_SECURITY_GRANT_PATTERN.test(value) &&
  Buffer.from(value, 'base64url').length === ADMIN_SECURITY_GRANT_BYTES &&
  Buffer.from(value, 'base64url').toString('base64url') === value;

const hash = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');

export const hashAdminRecoveryGrant = (input: {
  rawGrant: string;
  purpose: AdminRecoveryPurpose;
  targetPublicId: string;
  environment: string;
}): string => {
  if (
    !isCanonicalAdminSecurityGrant(input.rawGrant) ||
    !Object.values(AdminRecoveryPurpose).includes(input.purpose) ||
    !isValidAdminPublicId(input.targetPublicId) ||
    !/^(developer|test|production)$/.test(input.environment)
  ) {
    throw new TypeError('Admin recovery grant context không hợp lệ');
  }
  return hash([
    RECOVERY_DOMAIN,
    input.purpose,
    input.targetPublicId,
    input.environment,
    input.rawGrant,
  ]);
};

export const hashAdminReauthGrant = (input: {
  rawGrant: string;
  purpose: AdminReauthPurpose;
  adminPublicId: string;
  sessionPublicId: string;
  targetPublicId: string;
}): string => {
  if (
    !isCanonicalAdminSecurityGrant(input.rawGrant) ||
    !Object.values(AdminReauthPurpose).includes(input.purpose) ||
    !isValidAdminPublicId(input.adminPublicId) ||
    !/^ases_[A-Za-z0-9_-]{16,60}$/.test(input.sessionPublicId) ||
    !/^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{8,64}$/.test(input.targetPublicId)
  ) {
    throw new TypeError('Admin re-auth grant context không hợp lệ');
  }
  return hash([
    REAUTH_DOMAIN,
    input.purpose,
    input.adminPublicId,
    input.sessionPublicId,
    input.targetPublicId,
    input.rawGrant,
  ]);
};

export const generateAdminRecoveryGrantPublicId = (): string =>
  `argr_${randomBytes(18).toString('base64url')}`;

export const generateAdminReauthGrantPublicId = (): string =>
  `argt_${randomBytes(18).toString('base64url')}`;
