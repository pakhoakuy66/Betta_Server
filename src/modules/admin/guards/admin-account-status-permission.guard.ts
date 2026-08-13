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
import { getAdminAccountStatusPermission } from '../constants/admin-account-status.constants';
import { hasAdminPermission } from '../constants/admin-permission.constants';
import { isAdminRequestPrincipal } from '../types/admin-authenticated-request';

const ADMIN_STATUS_PERMISSION_DENIED_MESSAGE =
  'Không có quyền thay đổi trạng thái tài khoản quản trị';

type StatusRequest = Request & {
  user?: unknown;
  body?: unknown;
};

@Injectable()
export class AdminAccountStatusPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StatusRequest>();
    if (!isAdminRequestPrincipal(request.user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }

    const status = this.readStatus(request.body);
    const permission = getAdminAccountStatusPermission(status);
    if (!permission) {
      throw new BadRequestException(
        'Trạng thái AdminAccount yêu cầu không hợp lệ',
      );
    }
    if (!hasAdminPermission(request.user.role, permission)) {
      throw new ForbiddenException(ADMIN_STATUS_PERMISSION_DENIED_MESSAGE);
    }

    return true;
  }

  private readStatus(body: unknown): unknown {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return undefined;
    }
    return (body as Record<string, unknown>).status;
  }
}
