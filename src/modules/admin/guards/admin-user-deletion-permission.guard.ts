import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ADMIN_AUTHENTICATION_FAILED_MESSAGE } from '../constants/admin-auth-token.constants';
import { hasAdminPermission } from '../constants/admin-permission.constants';
import { getAdminUserDeletionPermission } from '../constants/admin-user-deletion.constants';
import { isAdminRequestPrincipal } from '../types/admin-authenticated-request';

type DeletionRequest = Request & { user?: unknown; body?: unknown };

@Injectable()
export class AdminUserDeletionPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DeletionRequest>();
    if (!isAdminRequestPrincipal(request.user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
    const body = this.readBody(request.body);
    const permission = getAdminUserDeletionPermission(body?.operation);
    if (!permission) {
      throw new BadRequestException('Thao tác xóa User không hợp lệ');
    }
    if (!hasAdminPermission(request.user.role, permission)) {
      throw new ForbiddenException(
        'Không có quyền thay đổi trạng thái xóa của User',
      );
    }
    return true;
  }

  private readBody(body: unknown): Record<string, unknown> | undefined {
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  }
}
