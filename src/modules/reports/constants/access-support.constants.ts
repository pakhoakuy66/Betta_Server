export const ACCESS_SUPPORT_CATEGORIES = Object.freeze([
  'LOGIN_PROBLEM',
  'PASSWORD_RESET_OR_OTP',
  'GOOGLE_SIGN_IN_PROBLEM',
  'ACCOUNT_RESTRICTED',
  'OTHER_ACCOUNT_ACCESS_ISSUE',
] as const);

export type AccessSupportCategory = (typeof ACCESS_SUPPORT_CATEGORIES)[number];

export const ACCESS_SUPPORT_ACKNOWLEDGEMENT =
  'Yêu cầu hỗ trợ đã được ghi nhận. Chúng tôi sẽ xem xét thông tin bạn cung cấp.';
export const ACCESS_SUPPORT_SENSITIVE_DATA_MESSAGE =
  'Không gửi mật khẩu, OTP, access token, refresh token hoặc mã khôi phục';
export const ACCESS_SUPPORT_CHALLENGE_ERROR =
  'ACCESS_SUPPORT_CHALLENGE_REQUIRED' as const;
export const ACCESS_SUPPORT_CHALLENGE_MESSAGE =
  'Cần hoàn thành bước xác minh trước khi gửi yêu cầu hỗ trợ';

export const ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH = 20;
export const ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH = 2_000;
export const ACCESS_SUPPORT_ACCOUNT_IDENTIFIER_MAX_LENGTH = 254;
export const ACCESS_SUPPORT_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const ACCESS_SUPPORT_BODY_MAX_BYTES = 12 * 1024;
export const ACCESS_SUPPORT_IP_LIMIT = 10;
export const ACCESS_SUPPORT_IP_WINDOW_SECONDS = 15 * 60;
export const ACCESS_SUPPORT_CHALLENGE_FROM_REQUEST = 3;
export const ACCESS_SUPPORT_CHALLENGE_TTL_SECONDS = 5 * 60;
export const ACCESS_SUPPORT_CHALLENGE_DIFFICULTY_BITS = 16;
export const ACCESS_SUPPORT_CONTACT_LIMIT = 3;
export const ACCESS_SUPPORT_CONTACT_WINDOW_SECONDS = 60 * 60;
export const ACCESS_SUPPORT_DEDUPE_WINDOW_SECONDS = 15 * 60;
export const ACCESS_SUPPORT_DEDUPE_TTL_BUFFER_SECONDS = 24 * 60 * 60;
export const ACCESS_SUPPORT_RATE_LIMIT_TTL_BUFFER_SECONDS = 60;

export const ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN =
  /^srep_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{16}$/;

export const ACCESS_SUPPORT_ENCRYPTED_PREFIX = 'asenc.v1';
export const ACCESS_SUPPORT_ENCRYPTION_AAD_DOMAIN =
  'betta.access-support.contact.v1';
