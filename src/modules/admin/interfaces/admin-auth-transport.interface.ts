import { type AdminRole } from '../constants/admin-account.constants';

export type AdminAuthTransportResponse = Readonly<{
  accessToken: string;
  csrfToken: string;
  accessTokenExpiresInSeconds: number;
  refreshCredentialExpiresAt: string;
  sessionId: string;
  admin: Readonly<{
    id: string;
    publicId: string;
    username: string;
    displayName: string;
    role: AdminRole;
  }>;
}>;

export type AdminCsrfBootstrapResponse = Readonly<{
  csrfToken: string;
}>;

export type PublicAdminPrincipal = Readonly<{
  id: string;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
}>;
