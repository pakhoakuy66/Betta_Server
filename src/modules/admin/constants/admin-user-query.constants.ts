import { UserRestrictionType } from '../../users/constants/user-moderation.constants';

export const ADMIN_USER_QUERY_DEFAULT_PAGE = 1 as const;
export const ADMIN_USER_QUERY_DEFAULT_LIMIT = 20 as const;
export const ADMIN_USER_QUERY_MAX_LIMIT = 100 as const;
export const ADMIN_USER_QUERY_MAX_OFFSET = 10_000 as const;
export const ADMIN_USER_QUERY_MAX_PAGE = ADMIN_USER_QUERY_MAX_OFFSET + 1;

export const ADMIN_USER_LIST_ACCESSED_EVENT =
  'ADMIN_USER_LIST_ACCESSED' as const;
export const ADMIN_USER_DETAIL_ACCESSED_EVENT =
  'ADMIN_USER_DETAIL_ACCESSED' as const;

export const ADMIN_USER_QUERY_SEARCH_PATTERN =
  /^[A-Za-z0-9+][A-Za-z0-9@._+()\- ]{0,253}$/;

export const ADMIN_USER_PUBLIC_ID_PATTERN =
  /^usr_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{10}$/;

export enum AdminUserDeletionFilter {
  ACTIVE = 'ACTIVE',
  DELETED = 'DELETED',
}

export enum AdminUserRestrictionFilter {
  NONE = 'NONE',
  TEMPORARY_SUSPENSION = UserRestrictionType.TEMPORARY_SUSPENSION,
  INDEFINITE_BAN = UserRestrictionType.INDEFINITE_BAN,
}

export enum AdminUserLoginLockFilter {
  LOCKED = 'LOCKED',
  UNLOCKED = 'UNLOCKED',
}

export enum AdminUserSort {
  CREATED_AT_DESC = 'createdAt_desc',
  USERNAME_ASC = 'username_asc',
}

export const isValidAdminUserPublicId = (value: unknown): boolean =>
  typeof value === 'string' && ADMIN_USER_PUBLIC_ID_PATTERN.test(value);
