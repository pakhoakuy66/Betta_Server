// auth.interface.ts

export interface TokenPayload {
  sub: string; // user._id as string
  email: string;
  username: string;
}

export interface NotificationSettingsResponse {
  enabled: boolean;
  follow: boolean;
  reaction: boolean;
  recap: boolean;
}

export interface PublicUser {
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar: string | null;
  hasCustomAvatar: boolean;
  streakCount: number;
  status: string;
  notificationSettings: NotificationSettingsResponse;
}

export interface AuthResponse {
  message: string;
  access_token: string;
  refresh_token: string;
  user: PublicUser;
}

export interface RegisterResponse {
  success: boolean;
  message: string;
}
