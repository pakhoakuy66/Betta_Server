import { UnauthorizedException } from '@nestjs/common';

import { GOOGLE_OAUTH_CONTINUATION_PUBLIC_ERROR_MESSAGE } from './google-oauth-continuation-grant-invalid.exception';

/**
 * Grant đã được consume bên trong transaction nhưng tài khoản đích
 * không còn đủ điều kiện liên kết.
 *
 * Transaction sẽ rollback, vì vậy grant có thể vẫn còn hợp lệ.
 */
export class GoogleOAuthAccountLinkUnavailableException extends UnauthorizedException {
  constructor() {
    super(GOOGLE_OAUTH_CONTINUATION_PUBLIC_ERROR_MESSAGE);
  }
}
