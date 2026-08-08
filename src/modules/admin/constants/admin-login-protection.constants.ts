export const ADMIN_LOGIN_PROTECTION_COLLECTION =
  'admin_login_protections' as const;

export const ADMIN_LOGIN_PROTECTION_KEY_INDEX =
  'admin_login_protection_scope_locator_unique' as const;
export const ADMIN_LOGIN_PROTECTION_TTL_INDEX =
  'admin_login_protection_expiresAt_ttl' as const;

export const ADMIN_LOGIN_PROTECTION_KEY_DOMAIN =
  'betta:admin-login-protection:v1' as const;
export const ADMIN_LOGIN_PROTECTION_MAX_KEY_LOCATORS = 16 as const;
export const ADMIN_LOGIN_IP_LIMIT_MULTIPLIER = 4 as const;
export const ADMIN_LOGIN_MINIMUM_IP_LIMIT = 20 as const;

export const ADMIN_LOGIN_RATE_LIMIT_MESSAGE =
  'Không thể đăng nhập lúc này. Vui lòng thử lại sau.' as const;
export const ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE =
  'Không thể kiểm tra trạng thái đăng nhập' as const;

export enum AdminLoginProtectionScope {
  ACCOUNT = 'account',
  IP = 'ip',
}
