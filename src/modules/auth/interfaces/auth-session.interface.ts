export type AccessTokenPayload = {
  tokenUse: 'access';
  sub: string;
  sid: string;
  email: string;
  username: string;
  authzVersion: number;
};

export type RefreshTokenPayload = {
  tokenUse: 'refresh';
  sub: string;
  sid: string;
  family: string;
  version: number;
};

export type SessionRequestMetadata = {
  userAgent?: string;
};

export type PublicAuthSession = {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

export type AuthSessionPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type AuthSessionPage = {
  items: PublicAuthSession[];
  pagination: AuthSessionPagination;
};
