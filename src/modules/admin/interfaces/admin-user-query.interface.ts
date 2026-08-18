import {
  type UserDeletionOrigin,
  type UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import { type UserStatus } from '../../users/schemas/user.schema';
import {
  type AdminUserDeletionFilter,
  type AdminUserLoginLockFilter,
  type AdminUserRestrictionFilter,
  type AdminUserSort,
} from '../constants/admin-user-query.constants';

export type AdminUserListQuery = Readonly<{
  page: number;
  limit: number;
  status?: UserStatus;
  deletion?: AdminUserDeletionFilter;
  restriction?: AdminUserRestrictionFilter;
  loginLock?: AdminUserLoginLockFilter;
  sort: AdminUserSort;
  search?: string;
}>;

export type PublicMaskedUserContact = Readonly<{
  email: string;
  phone: string;
}>;

export type PublicAdminUserRestriction = Readonly<{
  type: UserRestrictionType;
  effectiveAt: string;
  expiresAt: string | null;
  supportReference: string;
  publicReasonCode: string;
}>;

export type PublicAdminUserDeletion = Readonly<{
  isDeleted: boolean;
  origin: UserDeletionOrigin | null;
  deletedAt: string | null;
  restorableUntil: string | null;
}>;

export type PublicAdminUserLoginLock = Readonly<{
  isLocked: boolean;
  lockedUntil: string | null;
}>;

export type PublicAdminUserListItem = Readonly<{
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
  contact: PublicMaskedUserContact;
  status: UserStatus;
  restriction: PublicAdminUserRestriction | null;
  deletion: PublicAdminUserDeletion;
  loginLock: PublicAdminUserLoginLock;
  version: number;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type PublicUserSessionSummary = Readonly<{
  activeCount: number;
  lastActiveAt: string | null;
}>;

export type PublicAdminUserActivitySummary = Readonly<{
  reportCount: number;
  moderationActionCount: number;
}>;

export type PublicAdminUserDetail = PublicAdminUserListItem &
  Readonly<{
    profile: Readonly<{
      bio: string;
      link: string;
      streakCount: number;
      postsCount: number;
      followersCount: number;
      followingCount: number;
    }>;
    sessionSummary: PublicUserSessionSummary;
    activitySummary: PublicAdminUserActivitySummary;
  }>;

export type AdminUserPage = Readonly<{
  items: readonly PublicAdminUserListItem[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
