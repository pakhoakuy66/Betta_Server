import { describe, expect, it } from '@jest/globals';
import { UserRestrictionType } from '../constants/user-moderation.constants';
import {
  isActiveUserRestriction,
  normalizePublicUserRestriction,
  toPublicUserRestriction,
} from './user-restriction';

const restriction = {
  type: UserRestrictionType.TEMPORARY_SUSPENSION,
  effectiveAt: new Date('2026-08-17T00:00:00.000Z'),
  expiresAt: new Date('2026-08-18T00:00:00.000Z'),
  supportReference: 'sup_12345678',
  publicReasonCode: 'policy_violation',
};

describe('User restriction contract', () => {
  it('distinguishes active, expired and indefinite restrictions', () => {
    expect(
      isActiveUserRestriction(
        restriction,
        new Date('2026-08-17T12:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isActiveUserRestriction(
        restriction,
        new Date('2026-08-18T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isActiveUserRestriction({
        ...restriction,
        type: UserRestrictionType.INDEFINITE_BAN,
        expiresAt: null,
      }),
    ).toBe(true);
  });

  it('maps only the approved public allowlist', () => {
    expect(toPublicUserRestriction(restriction)).toEqual({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      effectiveAt: '2026-08-17T00:00:00.000Z',
      expiresAt: '2026-08-18T00:00:00.000Z',
      supportReference: 'sup_12345678',
    });
    expect(JSON.stringify(toPublicUserRestriction(restriction))).not.toContain(
      'policy_violation',
    );
  });

  it('rejects extra fields at the exception-filter boundary', () => {
    expect(
      normalizePublicUserRestriction({
        ...toPublicUserRestriction(restriction),
        internalReason: 'secret',
      }),
    ).toBeUndefined();
  });
});
