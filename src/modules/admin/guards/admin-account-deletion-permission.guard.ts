import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { type Request } from 'express';
import { ADMIN_AUTHENTICATION_FAILED_MESSAGE } from '../constants/admin-auth-token.constants';
import { getAdminAccountDeletionPermission } from '../constants/admin-account-deletion.constants';
import { hasAdminPermission } from '../constants/admin-permission.constants';
import { isAdminRequestPrincipal } from '../types/admin-authenticated-request';

type DeletionRequest = Request & { user?: unknown; body?: unknown };

@Injectable()
export class AdminAccountDeletionPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DeletionRequest>();
    if (!isAdminRequestPrincipal(request.user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }

    const permission = getAdminAccountDeletionPermission(
      this.readAction(request.body),
    );
    if (!permission) {
      throw new BadRequestException('Thao tác xóa AdminAccount không hợp lệ');
    }
    if (!hasAdminPermission(request.user.role, permission)) {
      throw new ForbiddenException(
        'Không có quyền thay đổi trạng thái xóa tài khoản quản trị',
      );
    }
    return true;
  }

  private readAction(body: unknown): unknown {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return undefined;
    }
    return (body as Record<string, unknown>).action;
  }
}
