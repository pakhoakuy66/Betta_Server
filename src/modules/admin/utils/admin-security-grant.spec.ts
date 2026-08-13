import { describe, expect, it } from '@jest/globals';
import { AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import {
  generateAdminRecoveryGrantPublicId,
  generateAdminReauthGrantPublicId,
  generateAdminSecurityGrant,
  hashAdminReauthGrant,
  hashAdminRecoveryGrant,
  isCanonicalAdminSecurityGrant,
} from './admin-security-grant';

describe('admin-security-grant', () => {
  it('generates canonical independent 256-bit grants', () => {
    const first = generateAdminSecurityGrant();
    const second = generateAdminSecurityGrant();
    expect(first).not.toBe(second);
    expect(isCanonicalAdminSecurityGrant(first)).toBe(true);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
  });

  it.each(['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`])(
    'rejects malformed grant %s',
    (grant) => expect(isCanonicalAdminSecurityGrant(grant)).toBe(false),
  );

  it('domain-separates recovery hashes by purpose, target and environment', () => {
    const rawGrant = generateAdminSecurityGrant();
    const base = {
      rawGrant,
      purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
      targetPublicId: 'adm_23456789ABCD',
      environment: 'test',
    } as const;
    const hash = hashAdminRecoveryGrant(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(
      hashAdminRecoveryGrant({
        ...base,
        purpose: AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS,
      }),
    );
    expect(hash).not.toBe(
      hashAdminRecoveryGrant({ ...base, environment: 'production' }),
    );
  });

  it('binds re-auth hashes to principal, session, purpose and target', () => {
    const rawGrant = generateAdminSecurityGrant();
    const base = {
      rawGrant,
      purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
      adminPublicId: 'adm_23456789ABCD',
      sessionPublicId: 'ases_23456789ABCDEFGH',
      targetPublicId: 'adm_ABCDEFGHJKLM',
    } as const;
    const hash = hashAdminReauthGrant(base);
    expect(hash).not.toBe(
      hashAdminReauthGrant({
        ...base,
        sessionPublicId: 'ases_ABCDEFGHJKLMNPQR',
      }),
    );
  });

  it('generates namespace-separated public identifiers', () => {
    expect(generateAdminRecoveryGrantPublicId()).toMatch(/^argr_[\w-]{24}$/);
    expect(generateAdminReauthGrantPublicId()).toMatch(/^argt_[\w-]{24}$/);
  });
});
