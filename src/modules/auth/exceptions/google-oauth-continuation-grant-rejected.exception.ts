import { GoogleOAuthContinuationGrantInvalidException } from './google-oauth-continuation-grant-invalid.exception';

/**
 * Grant chắc chắn không còn sử dụng được. Public response
 * vẫn kế thừa message generic để không lộ trạng thái credential.
 */
export class GoogleOAuthContinuationGrantRejectedException extends GoogleOAuthContinuationGrantInvalidException {}
