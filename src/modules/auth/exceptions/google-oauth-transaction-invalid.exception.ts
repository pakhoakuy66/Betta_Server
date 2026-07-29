import { UnauthorizedException } from '@nestjs/common';

export const GOOGLE_OAUTH_TRANSACTION_PUBLIC_ERROR_MESSAGE =
  'Google OAuth transaction không hợp lệ hoặc đã hết hạn';

/**
 * Authorization transaction không thể được sử dụng.
 *
 * Exception riêng giúp HTTP callback chuyển lỗi definitive về một frontend
 * route cố định mà không nới lỏng state/PKCE replay protection.
 */
export class GoogleOAuthTransactionInvalidException extends UnauthorizedException {
  constructor() {
    super(GOOGLE_OAUTH_TRANSACTION_PUBLIC_ERROR_MESSAGE);
  }
}
