import { AdminRole } from '../constants/admin-account.constants';

export type AdminLoginInput = Readonly<{
  email: string;
  password: string;
  totpToken: string;
  trustedClientIp: string;
  userAgent?: string;
}>;

export type PublicAuthenticatedAdmin = Readonly<{
  id: string;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
}>;

export type AdminAuthenticationResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionPublicId: string;
  admin: PublicAuthenticatedAdmin;
}>;
