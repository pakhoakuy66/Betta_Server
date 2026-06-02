// auth.interface.ts

export interface TokenPayload {
  sub: string; // user._id as string
  email: string;
  username: string;
}

export interface PublicUser {
  id: string;
  publicId?: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar: string | null;
  streakCount: number;
  status: string;
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
