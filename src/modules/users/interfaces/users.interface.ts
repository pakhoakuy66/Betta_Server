export interface UserProfileResponse {
  id: string;
  username: string;
  fullname: string;
  avatar: string;
  bio: string;
  link: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  streakCount: number;
}
