import { describe, expect, it } from '@jest/globals';
import {
  adminTotpStep,
  createAdminTotp,
  encodeAdminTotpSecret,
  findMatchingAdminTotpStep,
} from './admin-totp';

describe('admin-totp', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');

  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('matches RFC 6238 SHA-1 at %s seconds', (seconds, expected) => {
    expect(createAdminTotp(secret, Math.floor(seconds / 30), 6)).toBe(expected);
  });

  it('accepts only the finite minus/plus one-step clock window', () => {
    const now = new Date('2026-08-08T08:00:00.000Z');
    const current = adminTotpStep(now, 30);
    for (const offset of [-1, 0, 1]) {
      expect(
        findMatchingAdminTotpStep({
          secret,
          token: createAdminTotp(secret, current + offset, 6),
          now,
          periodSeconds: 30,
          digits: 6,
          acceptedPastSteps: 1,
          acceptedFutureSteps: 1,
        }),
      ).toBe(current + offset);
    }
    expect(
      findMatchingAdminTotpStep({
        secret,
        token: createAdminTotp(secret, current + 2, 6),
        now,
        periodSeconds: 30,
        digits: 6,
        acceptedPastSteps: 1,
        acceptedFutureSteps: 1,
      }),
    ).toBeNull();
  });

  it('encodes a canonical unpadded Base32 secret', () => {
    expect(encodeAdminTotpSecret(secret)).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
  });
});
