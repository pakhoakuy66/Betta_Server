import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { readExactCorsOrigins } from '../../../common/config/exact-origin.config';
import { ADMIN_AUTH_INVALID_ORIGIN_MESSAGE } from '../constants/admin-auth-transport.constants';

@Injectable()
export class AdminAuthOriginGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    this.allowedOrigins = new Set(readExactCorsOrigins(configService));
  }

  canActivate(context: ExecutionContext): true {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get('origin');

    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new ForbiddenException(ADMIN_AUTH_INVALID_ORIGIN_MESSAGE);
    }

    return true;
  }
}
