import {
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  UserRestrictionType,
} from '../constants/user-moderation.constants';
import type { UserRestriction } from '../schemas/user.schema';
import type { PublicAccountRestriction } from '../../../common/security/public-account-restriction';
export { normalizePublicAccountRestriction as normalizePublicUserRestriction } from '../../../common/security/public-account-restriction';

export type PublicUserRestriction = PublicAccountRestriction;

type RestrictionSource = Pick<
  UserRestriction,
  'type' | 'effectiveAt' | 'expiresAt' | 'supportReference' | 'publicReasonCode'
>;

export const isActiveUserRestriction = (
  restriction: RestrictionSource | null | undefined,
  now = new Date(),
): restriction is RestrictionSource => {
  if (!restriction) return false;
  if (restriction.type === UserRestrictionType.INDEFINITE_BAN) return true;
  return (
    restriction.type === UserRestrictionType.TEMPORARY_SUSPENSION &&
    restriction.expiresAt instanceof Date &&
    restriction.expiresAt.getTime() > now.getTime()
  );
};

export const assertValidUserRestriction = (
  restriction: RestrictionSource,
): void => {
  const effectiveAt = restriction.effectiveAt;
  const expiresAt = restriction.expiresAt;
  const validExpiry =
    restriction.type === UserRestrictionType.INDEFINITE_BAN
      ? expiresAt == null
      : restriction.type === UserRestrictionType.TEMPORARY_SUSPENSION &&
        expiresAt instanceof Date &&
        !Number.isNaN(expiresAt.getTime()) &&
        effectiveAt instanceof Date &&
        expiresAt.getTime() > effectiveAt.getTime();

  if (
    !(effectiveAt instanceof Date) ||
    Number.isNaN(effectiveAt.getTime()) ||
    !validExpiry ||
    !USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN.test(
      restriction.supportReference,
    ) ||
    !USER_RESTRICTION_PUBLIC_REASON_PATTERN.test(restriction.publicReasonCode)
  ) {
    throw new TypeError('User restriction state không hợp lệ');
  }
};

export const toPublicUserRestriction = (
  restriction: RestrictionSource,
): PublicUserRestriction => {
  assertValidUserRestriction(restriction);
  return Object.freeze({
    type: restriction.type,
    effectiveAt: restriction.effectiveAt.toISOString(),
    expiresAt: restriction.expiresAt?.toISOString() ?? null,
    supportReference: restriction.supportReference,
  });
};
