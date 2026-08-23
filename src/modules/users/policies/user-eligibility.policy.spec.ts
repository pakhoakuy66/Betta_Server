import { describe, expect, it } from '@jest/globals';
import { UserRestrictionType } from '../constants/user-moderation.constants';
import {
  buildEligibleUserMatch,
  isUserEligible,
  withEligibleUserMatch,
} from './user-eligibility.policy';

const NOW = new Date('2026-08-20T10:00:00.000Z');

describe('User eligibility policy', () => {
  it.each([
    { isDeleted: true, status: 'active', restriction: null },
    { isDeleted: false, status: 'banned', restriction: null },
    {
      isDeleted: false,
      status: 'active',
      restriction: {
        type: UserRestrictionType.INDEFINITE_BAN,
        expiresAt: null,
      },
    },
    {
      isDeleted: false,
      status: 'active',
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
        expiresAt: new Date('2026-08-20T10:00:00.001Z'),
      },
    },
    {
      isDeleted: false,
      status: 'active',
      restriction: { type: 'UNKNOWN', expiresAt: null },
    },
  ])('fails closed for an ineligible snapshot', (snapshot) => {
    expect(isUserEligible(snapshot, NOW)).toBe(false);
  });

  it('allows active users without restriction and at the expiry boundary', () => {
    expect(
      isUserEligible(
        { isDeleted: false, status: 'active', restriction: null },
        NOW,
      ),
    ).toBe(true);
    expect(
      isUserEligible(
        {
          isDeleted: false,
          status: 'active',
          restriction: {
            type: UserRestrictionType.TEMPORARY_SUSPENSION,
            expiresAt: NOW,
          },
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('builds one reusable MongoDB policy for root and lookup documents', () => {
    expect(buildEligibleUserMatch(NOW)).toEqual({
      isDeleted: false,
      status: 'active',
      $or: [
        { restriction: null },
        {
          'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION,
          'restriction.expiresAt': { $type: 'date', $lte: NOW },
        },
      ],
    });
    expect(buildEligibleUserMatch(NOW, 'author')).toEqual(
      expect.objectContaining({
        'author.isDeleted': false,
        'author.status': 'active',
      }),
    );
    expect(withEligibleUserMatch({ username: 'khoa' }, NOW)).toEqual({
      $and: [{ username: 'khoa' }, buildEligibleUserMatch(NOW)],
    });
  });
});
