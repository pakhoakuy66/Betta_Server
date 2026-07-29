import { UnauthorizedException } from '@nestjs/common';

export const GOOGLE_OAUTH_CONTINUATION_PUBLIC_ERROR_MESSAGE =
  'Yêu cầu Google OAuth không hợp lệ hoặc đã hết hạn';

/**
 * Continuation grant consume request bị từ chối.
 *
 * Exception này không khẳng định grant chắc chắn đã mất hiệu lực.
 * Caller không được suy luận rằng luôn an toàn để xóa cookie.
 */
export class GoogleOAuthContinuationGrantInvalidException extends UnauthorizedException {
  constructor() {
    super(GOOGLE_OAUTH_CONTINUATION_PUBLIC_ERROR_MESSAGE);
  }
}
