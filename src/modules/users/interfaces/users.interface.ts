export interface UserProfileResponse {
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
  hasCustomAvatar: boolean;
  bio?: string;
  link?: string;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  streakCount?: number;
  isFollowing?: boolean;
  isBlocked?: boolean;
}
