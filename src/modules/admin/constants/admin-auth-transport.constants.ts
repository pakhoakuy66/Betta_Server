export const ADMIN_AUTH_ROUTE = 'admin/auth' as const;

export const ADMIN_REFRESH_COOKIE_DEVELOPMENT_NAME =
  'betta_admin_refresh' as const;
export const ADMIN_REFRESH_COOKIE_PRODUCTION_NAME =
  '__Host-betta_admin_refresh' as const;
export const ADMIN_CSRF_COOKIE_DEVELOPMENT_NAME = 'betta_admin_csrf' as const;
export const ADMIN_CSRF_COOKIE_PRODUCTION_NAME =
  '__Host-betta_admin_csrf' as const;

export const ADMIN_AUTH_COOKIE_PATH = '/' as const;
export const ADMIN_CSRF_HEADER_NAME = 'x-admin-csrf-token' as const;
export const ADMIN_CSRF_TOKEN_BYTES = 32 as const;
export const ADMIN_CSRF_TOKEN_LENGTH = 43 as const;
export const ADMIN_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const ADMIN_AUTH_INVALID_ORIGIN_MESSAGE =
  'Nguon yeu cau quan tri khong hop le' as const;
export const ADMIN_AUTH_INVALID_CSRF_MESSAGE =
  'Yeu cau quan tri khong hop le' as const;
export const ADMIN_AUTH_INVALID_COOKIE_MESSAGE =
  'Phien quan tri khong hop le hoac da bi thu hoi' as const;

export type AdminAuthCookieSameSite = 'strict' | 'none';
