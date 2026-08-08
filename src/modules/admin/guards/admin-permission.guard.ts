import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  hasAdminPermission,
  isAdminPermission,
  type AdminPermission,
} from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { ADMIN_AUTHENTICATION_FAILED_MESSAGE } from '../constants/admin-auth-token.constants';
import {
  type AdminAuthenticatedRequest,
  isAdminRequestPrincipal,
} from '../types/admin-authenticated-request';

const ADMIN_PERMISSION_DENIED_MESSAGE =
  'Không có quyền truy cập tài nguyên quản trị';

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();

    if (!isAdminRequestPrincipal(request.user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }

    const classPermissions = this.readPermissions(
      this.reflector.get<unknown>(
        ADMIN_PERMISSIONS_METADATA,
        context.getClass(),
      ),
    );
    const handlerPermissions = this.readPermissions(
      this.reflector.get<unknown>(
        ADMIN_PERMISSIONS_METADATA,
        context.getHandler(),
      ),
    );
    const requiredPermissions = new Set<AdminPermission>([
      ...classPermissions,
      ...handlerPermissions,
    ]);

    if (requiredPermissions.size === 0) this.deny();

    for (const permission of requiredPermissions) {
      if (!hasAdminPermission(request.user.role, permission)) this.deny();
    }

    return true;
  }

  private readPermissions(metadata: unknown): readonly AdminPermission[] {
    if (metadata === undefined) return [];

    if (
      !Array.isArray(metadata) ||
      metadata.length === 0 ||
      !metadata.every(isAdminPermission)
    ) {
      this.deny();
    }

    return metadata;
  }

  private deny(): never {
    throw new ForbiddenException(ADMIN_PERMISSION_DENIED_MESSAGE);
  }
}
