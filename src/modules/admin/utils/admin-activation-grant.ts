import { createHash, randomBytes } from 'node:crypto';
import {
  ADMIN_BOOTSTRAP_GRANT_BYTES,
  ADMIN_BOOTSTRAP_GRANT_LENGTH,
  ADMIN_BOOTSTRAP_GRANT_PATTERN,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import { type AdminBootstrapGrantContext } from '../interfaces/admin-bootstrap.interface';
import { isValidAdminPublicId } from './generate-admin-public-id';

const HASH_DOMAIN = 'betta.admin.activation-grant.v1';

export const generateAdminActivationGrant = (): string =>
  randomBytes(ADMIN_BOOTSTRAP_GRANT_BYTES).toString('base64url');

export const isCanonicalAdminActivationGrant = (value: unknown): boolean => {
  if (
    typeof value !== 'string' ||
    value.length !== ADMIN_BOOTSTRAP_GRANT_LENGTH ||
    !ADMIN_BOOTSTRAP_GRANT_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    const decoded = Buffer.from(value, 'base64url');
    return (
      decoded.length === ADMIN_BOOTSTRAP_GRANT_BYTES &&
      decoded.toString('base64url') === value
    );
  } catch {
    return false;
  }
};

export const hashAdminActivationGrant = (
  rawGrant: string,
  context: AdminBootstrapGrantContext,
): string => {
  if (
    !isCanonicalAdminActivationGrant(rawGrant) ||
    !isValidAdminPublicId(context.targetPublicId) ||
    !Object.values(AdminActivationGrantPurpose).includes(context.purpose) ||
    !Object.values(AdminBootstrapEnvironment).includes(context.environment)
  ) {
    throw new TypeError('Admin activation grant context is invalid');
  }

  return createHash('sha256')
    .update(HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(context.purpose, 'utf8')
    .update('\0', 'utf8')
    .update(context.targetPublicId, 'utf8')
    .update('\0', 'utf8')
    .update(context.environment, 'utf8')
    .update('\0', 'utf8')
    .update(rawGrant, 'utf8')
    .digest('hex');
};
