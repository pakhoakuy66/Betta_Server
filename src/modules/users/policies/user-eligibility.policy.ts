import { UserRestrictionType } from '../constants/user-moderation.constants';

export type UserEligibilitySnapshot = Readonly<{
  isDeleted?: boolean;
  status?: string;
  restriction?: Readonly<{
    type?: string;
    expiresAt?: Date | null;
  }> | null;
}>;

export type MongoEligibilityMatch = Record<string, unknown>;

const pathFor = (prefix: string, field: string): string =>
  prefix.length === 0 ? field : `${prefix}.${field}`;

/**
 * Public surfaces fail closed: only a valid, expired temporary suspension is
 * eligible. Unknown or malformed moderation state remains hidden.
 */
export const isUserEligible = (
  user: UserEligibilitySnapshot | null | undefined,
  now = new Date(),
): boolean => {
  if (!user || user.isDeleted !== false || user.status !== 'active') {
    return false;
  }

  if (user.restriction == null) return true;

  return (
    user.restriction.type === UserRestrictionType.TEMPORARY_SUSPENSION &&
    user.restriction.expiresAt instanceof Date &&
    !Number.isNaN(user.restriction.expiresAt.getTime()) &&
    user.restriction.expiresAt.getTime() <= now.getTime()
  );
};

export const buildEligibleUserMatch = (
  now = new Date(),
  prefix = '',
): MongoEligibilityMatch => ({
  [pathFor(prefix, 'isDeleted')]: false,
  [pathFor(prefix, 'status')]: 'active',
  $or: [
    { [pathFor(prefix, 'restriction')]: null },
    {
      [pathFor(prefix, 'restriction.type')]:
        UserRestrictionType.TEMPORARY_SUSPENSION,
      [pathFor(prefix, 'restriction.expiresAt')]: {
        $type: 'date',
        $lte: now,
      },
    },
  ],
});

export const withEligibleUserMatch = (
  baseMatch: MongoEligibilityMatch,
  now = new Date(),
  prefix = '',
): MongoEligibilityMatch => ({
  $and: [baseMatch, buildEligibleUserMatch(now, prefix)],
});
