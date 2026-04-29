import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Cho phép đi qua ngay cả khi không có token hoặc token sai
  handleRequest(err, user, info) {
    return user; 
  }
}
