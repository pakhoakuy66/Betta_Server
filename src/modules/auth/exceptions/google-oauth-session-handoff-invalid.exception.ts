import { UnauthorizedException } from '@nestjs/common';

export class GoogleOAuthSessionHandoffInvalidException extends UnauthorizedException {
  constructor() {
    super('Google OAuth session handoff không hợp lệ hoặc đã hết hạn');
  }
}
