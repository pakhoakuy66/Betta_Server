import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { readExactCorsOrigins } from '../../../common/config/exact-origin.config';

const INVALID_ORIGIN_MESSAGE = 'Nguồn yêu cầu OAuth không hợp lệ';

@Injectable()
export class GoogleOAuthContinuationOriginGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    this.allowedOrigins = new Set(readExactCorsOrigins(configService));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const origin = request.get('origin');

    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new ForbiddenException(INVALID_ORIGIN_MESSAGE);
    }

    return true;
  }
}
