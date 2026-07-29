import { ConflictException } from '@nestjs/common';

export class GoogleOAuthAccountUnlinkUnavailableException extends ConflictException {
  constructor() {
    super('Không thể hủy liên kết tài khoản Google');
  }
}
