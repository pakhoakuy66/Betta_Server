import { type Types } from 'mongoose';
import {
  type UserDeletionOrigin,
  type UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import { type UserStatus } from '../../users/schemas/user.schema';
import {
  type PublicAdminUserDetail,
  type PublicAdminUserListItem,
  type PublicAdminUserActivitySummary,
  type PublicAdminUserRestriction,
  type PublicUserSessionSummary,
} from '../interfaces/admin-user-query.interface';

type RestrictionSource = Readonly<{
  type: UserRestrictionType;
  effectiveAt: Date;
  expiresAt: Date | null;
  supportReference: string;
  publicReasonCode: string;
}>;

export type ManagedUserSource = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar: string;
  bio?: string;
  link?: string;
  status: UserStatus;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletionOrigin?: UserDeletionOrigin | null;
  restorableUntil?: Date | null;
  restriction?: RestrictionSource | null;
  version: number;
  lockedUntil?: Date | null;
  streakCount?: number;
  postsCount?: number;
  followersCount?: number;
  followingCount?: number;
  lastActive?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

const toIsoOrNull = (value?: Date | null): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;

const maskEmail = (value: string): string => {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return '***';
  return `${value.slice(0, 1)}***${value.slice(separator)}`;
};

const maskPhone = (value: string): string => {
  const visible = value.slice(-4);
  return `${'*'.repeat(Math.max(4, value.length - visible.length))}${visible}`;
};

const toRestriction = (
  restriction?: RestrictionSource | null,
): PublicAdminUserRestriction | null =>
  restriction
    ? Object.freeze({
        type: restriction.type,
        effectiveAt: restriction.effectiveAt.toISOString(),
        expiresAt: toIsoOrNull(restriction.expiresAt),
        supportReference: restriction.supportReference,
        publicReasonCode: restriction.publicReasonCode,
      })
    : null;

export const toPublicAdminUserListItem = (
  user: ManagedUserSource,
  now = new Date(),
): PublicAdminUserListItem =>
  Object.freeze({
    id: user.publicId,
    publicId: user.publicId,
    username: user.username,
    fullname: user.fullname,
    avatar: user.avatar,
    contact: Object.freeze({
      email: maskEmail(user.email),
      phone: maskPhone(user.phone),
    }),
    status: user.status,
    restriction: toRestriction(user.restriction),
    deletion: Object.freeze({
      isDeleted: user.isDeleted,
      origin: user.deletionOrigin ?? null,
      deletedAt: toIsoOrNull(user.deletedAt),
      restorableUntil: toIsoOrNull(user.restorableUntil),
    }),
    loginLock: Object.freeze({
      isLocked:
        user.lockedUntil instanceof Date &&
        user.lockedUntil.getTime() > now.getTime(),
      lockedUntil: toIsoOrNull(user.lockedUntil),
    }),
    version: user.version,
    lastActiveAt: toIsoOrNull(user.lastActive),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });

export const toPublicAdminUserDetail = (
  user: ManagedUserSource,
  sessionSummary: PublicUserSessionSummary,
  activitySummary: PublicAdminUserActivitySummary,
  now = new Date(),
): PublicAdminUserDetail =>
  Object.freeze({
    ...toPublicAdminUserListItem(user, now),
    profile: Object.freeze({
      bio: user.bio ?? '',
      link: user.link ?? '',
      streakCount: user.streakCount ?? 0,
      postsCount: user.postsCount ?? 0,
      followersCount: user.followersCount ?? 0,
      followingCount: user.followingCount ?? 0,
    }),
    sessionSummary: Object.freeze({ ...sessionSummary }),
    activitySummary: Object.freeze({ ...activitySummary }),
  });
