import { UnauthorizedException } from '@nestjs/common';

export class GoogleOAuthSessionHandoffCookieInvalidException extends UnauthorizedException {
  constructor() {
    super('Google OAuth session handoff cookie khong hop le');
  }
}
