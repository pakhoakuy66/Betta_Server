import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ADMIN_AUTHENTICATION_FAILED_MESSAGE,
  ADMIN_JWT_STRATEGY,
} from '../constants/admin-auth-token.constants';
import {
  type AdminRequestPrincipal,
  isAdminRequestPrincipal,
} from '../types/admin-authenticated-request';

@Injectable()
export class AdminJwtAuthGuard extends AuthGuard(ADMIN_JWT_STRATEGY) {
  handleRequest<TUser = AdminRequestPrincipal>(
    error: unknown,
    user: unknown,
  ): TUser {
    if (error instanceof Error) throw error;

    if (error !== null && error !== undefined) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }

    if (!isAdminRequestPrincipal(user)) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }

    return user as TUser;
  }
}
