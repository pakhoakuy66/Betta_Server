import { describe, expect, it } from '@jest/globals';
import {
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import {
  generateAdminActivationGrant,
  hashAdminActivationGrant,
  isCanonicalAdminActivationGrant,
} from './admin-activation-grant';

const context = {
  purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
  targetPublicId: 'adm_23456789ABCD',
  environment: AdminBootstrapEnvironment.TEST,
} as const;

describe('admin activation grant', () => {
  it('generates canonical 32-byte Base64URL grants', () => {
    const grants = new Set(
      Array.from({ length: 128 }, generateAdminActivationGrant),
    );
    expect(grants.size).toBe(128);
    for (const grant of grants) {
      expect(grant).toHaveLength(43);
      expect(isCanonicalAdminActivationGrant(grant)).toBe(true);
    }
  });

  it.each(['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '='])(
    'rejects malformed grant %#',
    (grant) => expect(isCanonicalAdminActivationGrant(grant)).toBe(false),
  );

  it('binds the hash to purpose, target and environment', () => {
    const grant = generateAdminActivationGrant();
    const baseline = hashAdminActivationGrant(grant, context);

    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(
      hashAdminActivationGrant(grant, {
        ...context,
        targetPublicId: 'adm_23456789ABCE',
      }),
    ).not.toBe(baseline);
    expect(
      hashAdminActivationGrant(grant, {
        ...context,
        environment: AdminBootstrapEnvironment.PRODUCTION,
      }),
    ).not.toBe(baseline);
    expect(
      hashAdminActivationGrant(grant, {
        ...context,
        purpose: AdminActivationGrantPurpose.ADMIN_ACCOUNT_ACTIVATION,
      }),
    ).not.toBe(baseline);
  });
});
