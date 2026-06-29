import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Cho phép đi qua ngay cả khi không có token hoặc token sai
  handleRequest<TUser = unknown>(
    _err: unknown,
    user: TUser,
    _info: unknown,
    _context: ExecutionContext,
    _status?: unknown,
  ): TUser {
    void _info;
    void _context;
    void _status;

    return user;
  }
}
