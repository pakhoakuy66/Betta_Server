// auth.interface.ts

export interface TokenPayload {
  sub: string; // user._id as string
  email: string;
  username: string;
}

export interface PublicUser {
  _id: string;
  username: string;
  fullname: string;
  avatar: string | null;
  streakCount: number;
}

export interface AuthResponse {
  message: string;
  access_token: string;
  user: PublicUser;
}

export interface RegisterResponse {
  success: boolean;
  message: string;
}
