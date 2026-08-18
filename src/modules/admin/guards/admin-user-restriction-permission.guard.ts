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
import { getAdminUserRestrictionPermission } from '../constants/admin-user-restriction.constants';
import { isAdminRequestPrincipal } from '../types/admin-authenticated-request';

type RestrictionRequest = Request & { user?: unknown; body?: unknown };

@Injectable()
export class AdminUserRestrictionPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RestrictionRequest>();
    if (!isAdminRequestPrincipal(request.user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
    const body = this.readBody(request.body);
    const permission = getAdminUserRestrictionPermission(
      body?.operation,
      body?.restrictionType,
    );
    if (!permission) {
      throw new BadRequestException('Thao tác restriction User không hợp lệ');
    }
    if (!hasAdminPermission(request.user.role, permission)) {
      throw new ForbiddenException('Không có quyền hạn chế User theo yêu cầu');
    }
    return true;
  }

  private readBody(body: unknown): Record<string, unknown> | undefined {
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  }
}
