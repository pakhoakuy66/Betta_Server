import type { PublicUser } from '../interfaces/auth.interface';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_NOTIFICATION_SETTINGS,
  USER_STATUS,
  type User,
} from '../../users/schemas/user.schema';

export type PublicAuthUserSource = Pick<
  User,
  'publicId' | 'username' | 'fullname' | 'email' | 'phone'
> &
  Partial<
    Pick<
      User,
      'avatar' | 'avatarId' | 'streakCount' | 'status' | 'notificationSettings'
    >
  >;

export const toPublicAuthUser = (user: PublicAuthUserSource): PublicUser => ({
  id: user.publicId,
  publicId: user.publicId,
  username: user.username,
  fullname: user.fullname,
  email: user.email,
  phone: user.phone,
  avatar: user.avatar ?? null,
  hasCustomAvatar: user.avatarId !== DEFAULT_AVATAR_ID,
  streakCount: user.streakCount ?? 0,
  status: user.status ?? USER_STATUS.ACTIVE,
  notificationSettings: {
    enabled:
      user.notificationSettings?.enabled ??
      DEFAULT_NOTIFICATION_SETTINGS.enabled,
    follow:
      user.notificationSettings?.follow ?? DEFAULT_NOTIFICATION_SETTINGS.follow,
    reaction:
      user.notificationSettings?.reaction ??
      DEFAULT_NOTIFICATION_SETTINGS.reaction,
    recap:
      user.notificationSettings?.recap ?? DEFAULT_NOTIFICATION_SETTINGS.recap,
  },
});
