import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthCookieService } from '../services/admin-auth-cookie.service';

@Injectable()
export class AdminCsrfGuard implements CanActivate {
  constructor(private readonly cookies: AdminAuthCookieService) {}

  canActivate(context: ExecutionContext): true {
    const request = context.switchToHttp().getRequest<Request>();
    this.cookies.assertCsrf(request);
    return true;
  }
}
