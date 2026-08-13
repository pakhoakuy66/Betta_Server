import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { ADMIN_AUTH_MAX_REFRESH_TOKEN_LENGTH } from '../constants/admin-auth.constants';
import {
  ADMIN_AUTH_COOKIE_PATH,
  ADMIN_AUTH_INVALID_COOKIE_MESSAGE,
  ADMIN_AUTH_INVALID_CSRF_MESSAGE,
  ADMIN_CSRF_COOKIE_DEVELOPMENT_NAME,
  ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_CSRF_TOKEN_BYTES,
  ADMIN_CSRF_TOKEN_LENGTH,
  ADMIN_CSRF_TOKEN_PATTERN,
  ADMIN_REFRESH_COOKIE_DEVELOPMENT_NAME,
  ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
  type AdminAuthCookieSameSite,
} from '../constants/admin-auth-transport.constants';
import { type AdminAuthenticationResult } from '../interfaces/admin-auth.interface';

type AppEnvironment = 'developer' | 'test' | 'production';

@Injectable()
export class AdminAuthCookieService {
  private readonly secure: boolean;
  private readonly sameSite: AdminAuthCookieSameSite;
  private readonly refreshCookieName: string;
  private readonly csrfCookieName: string;

  constructor(configService: ConfigService) {
    const environment = this.readEnvironment(
      configService.get<string>('NODE_ENV'),
    );
    this.sameSite = this.readSameSite(
      configService.get<string>('ADMIN_AUTH_COOKIE_SAME_SITE'),
    );
    this.secure = environment === 'production';

    if (this.sameSite === 'none' && !this.secure) {
      throw new Error(
        'ADMIN_AUTH_COOKIE_SAME_SITE=none yeu cau NODE_ENV=production',
      );
    }

    this.refreshCookieName = this.secure
      ? ADMIN_REFRESH_COOKIE_PRODUCTION_NAME
      : ADMIN_REFRESH_COOKIE_DEVELOPMENT_NAME;
    this.csrfCookieName = this.secure
      ? ADMIN_CSRF_COOKIE_PRODUCTION_NAME
      : ADMIN_CSRF_COOKIE_DEVELOPMENT_NAME;
  }

  writeSession(
    response: Response,
    authentication: AdminAuthenticationResult,
  ): string {
    this.assertAuthentication(authentication);
    const maxAge = authentication.refreshTokenExpiresAt.getTime() - Date.now();

    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new TypeError('Admin refresh credential da het han');
    }

    const csrfToken = randomBytes(ADMIN_CSRF_TOKEN_BYTES).toString('base64url');

    response.cookie(this.refreshCookieName, authentication.refreshToken, {
      ...this.baseOptions(),
      httpOnly: true,
      expires: authentication.refreshTokenExpiresAt,
      maxAge,
    });
    response.cookie(this.csrfCookieName, csrfToken, {
      ...this.baseOptions(),
      httpOnly: true,
      expires: authentication.refreshTokenExpiresAt,
      maxAge,
    });

    return csrfToken;
  }

  readRefreshCredential(request: Request): string {
    const value = this.readUniqueCookie(request, this.refreshCookieName);

    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > ADMIN_AUTH_MAX_REFRESH_TOKEN_LENGTH
    ) {
      throw new UnauthorizedException(ADMIN_AUTH_INVALID_COOKIE_MESSAGE);
    }

    return value;
  }

  assertCsrf(request: Request): void {
    const cookieToken = this.readUniqueCookie(request, this.csrfCookieName);
    const headerToken = request.headers[ADMIN_CSRF_HEADER_NAME];

    if (
      !this.isCanonicalCsrfToken(cookieToken) ||
      !this.isCanonicalCsrfToken(headerToken)
    ) {
      throw new ForbiddenException(ADMIN_AUTH_INVALID_CSRF_MESSAGE);
    }

    const cookieBuffer = Buffer.from(cookieToken, 'ascii');
    const headerBuffer = Buffer.from(headerToken, 'ascii');

    if (!timingSafeEqual(cookieBuffer, headerBuffer)) {
      throw new ForbiddenException(ADMIN_AUTH_INVALID_CSRF_MESSAGE);
    }
  }

  readCsrfBootstrapProof(request: Request): string {
    this.readRefreshCredential(request);
    const csrfToken = this.readUniqueCookie(request, this.csrfCookieName);

    if (!this.isCanonicalCsrfToken(csrfToken)) {
      throw new UnauthorizedException(ADMIN_AUTH_INVALID_COOKIE_MESSAGE);
    }

    return csrfToken;
  }

  clearSession(response: Response): void {
    response.clearCookie(this.refreshCookieName, {
      ...this.baseOptions(),
      httpOnly: true,
    });
    response.clearCookie(this.csrfCookieName, {
      ...this.baseOptions(),
      httpOnly: true,
    });
  }

  private baseOptions(): CookieOptions {
    return {
      secure: this.secure,
      sameSite: this.sameSite,
      path: ADMIN_AUTH_COOKIE_PATH,
      priority: 'high',
    };
  }

  private readUniqueCookie(request: Request, name: string): string | undefined {
    const rawHeader = request.headers.cookie;
    if (!rawHeader) return undefined;

    const values: string[] = [];
    for (const segment of rawHeader.split(';')) {
      const separatorIndex = segment.indexOf('=');
      if (separatorIndex < 1) continue;

      const candidateName = segment.slice(0, separatorIndex).trim();
      if (candidateName !== name) continue;
      values.push(segment.slice(separatorIndex + 1).trim());
    }

    return values.length === 1 ? values[0] : undefined;
  }

  private isCanonicalCsrfToken(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length === ADMIN_CSRF_TOKEN_LENGTH &&
      ADMIN_CSRF_TOKEN_PATTERN.test(value)
    );
  }

  private assertAuthentication(value: AdminAuthenticationResult): void {
    if (
      typeof value.refreshToken !== 'string' ||
      value.refreshToken.length < 1 ||
      value.refreshToken.length > ADMIN_AUTH_MAX_REFRESH_TOKEN_LENGTH ||
      !(value.refreshTokenExpiresAt instanceof Date) ||
      !Number.isFinite(value.refreshTokenExpiresAt.getTime())
    ) {
      throw new TypeError('Admin authentication result khong hop le');
    }
  }

  private readEnvironment(value: string | undefined): AppEnvironment {
    const environment = value?.trim() || 'developer';
    if (
      environment !== 'developer' &&
      environment !== 'test' &&
      environment !== 'production'
    ) {
      throw new Error('NODE_ENV phai la developer, test hoac production');
    }
    return environment;
  }

  private readSameSite(value: string | undefined): AdminAuthCookieSameSite {
    const sameSite = value?.trim() || 'strict';
    if (sameSite !== 'strict' && sameSite !== 'none') {
      throw new Error('ADMIN_AUTH_COOKIE_SAME_SITE phai la strict hoac none');
    }
    return sameSite;
  }
}
