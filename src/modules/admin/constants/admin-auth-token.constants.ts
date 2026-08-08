export const ADMIN_JWT_STRATEGY = 'admin-jwt';
export const ADMIN_JWT_ALGORITHM = 'HS256' as const;
export const ADMIN_ACCESS_TOKEN_ISSUER = 'betta-admin';
export const ADMIN_ACCESS_TOKEN_AUDIENCE = 'betta-admin-api';
export const ADMIN_ACCESS_TOKEN_USE = 'admin_access';
export const ADMIN_REFRESH_TOKEN_AUDIENCE = 'betta-admin-refresh';
export const ADMIN_REFRESH_TOKEN_USE = 'admin_refresh';
export const ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 30;

export const ADMIN_AUTHENTICATION_FAILED_MESSAGE =
  'Phiên quản trị không hợp lệ hoặc đã hết hạn';
export const ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE =
  'Không thể xác thực phiên quản trị';

export const ADMIN_SESSION_PUBLIC_ID_PATTERN = /^ases_[A-Za-z0-9_-]{16,60}$/;
export const ADMIN_SESSION_FAMILY_PATTERN = /^afam_[A-Za-z0-9_-]{16,60}$/;
export const ADMIN_REFRESH_TOKEN_INVALID_MESSAGE =
  'Phiên quản trị không hợp lệ hoặc đã bị thu hồi';
