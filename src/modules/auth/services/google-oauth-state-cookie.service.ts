import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

import { GOOGLE_OAUTH_CALLBACK_PATH } from '../constants/google-oauth-route.constants';
import { GoogleOAuthStateCookieInvalidException } from '../exceptions/google-oauth-state-cookie-invalid.exception';

const COOKIE_NAME = 'betta_google_oauth_state';
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type AppEnvironment = 'developer' | 'test' | 'production';

const APP_ENVIRONMENTS = new Set<AppEnvironment>([
  'developer',
  'test',
  'production',
]);

@Injectable()
export class GoogleOAuthStateCookieService {
  private readonly secure: boolean;

  constructor(configService: ConfigService) {
    const environment = configService.get<string>('NODE_ENV') ?? 'developer';

    if (!APP_ENVIRONMENTS.has(environment as AppEnvironment)) {
      throw new Error('NODE_ENV phải là developer, test hoặc production');
    }

    this.secure = environment === 'production';
  }

  write(response: Response, browserState: string, expiresAt: Date): void {
    if (!this.isCanonicalState(browserState)) {
      throw new TypeError('Invalid Google OAuth browser state');
    }

    const maxAge = expiresAt.getTime() - Date.now();

    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new TypeError('Google OAuth browser state đã hết hạn');
    }

    response.cookie(COOKIE_NAME, browserState, {
      ...this.options(),
      expires: new Date(expiresAt),
      maxAge,
    });
  }

  read(request: Request): string {
    let state: string | undefined;

    try {
      state = parse(request.headers.cookie ?? '')[COOKIE_NAME];
    } catch {
      throw new GoogleOAuthStateCookieInvalidException();
    }

    if (!this.isCanonicalState(state)) {
      throw new GoogleOAuthStateCookieInvalidException();
    }

    return state;
  }

  clear(response: Response): void {
    response.clearCookie(COOKIE_NAME, this.options());
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: GOOGLE_OAUTH_CALLBACK_PATH,
      priority: 'high',
    };
  }

  private isCanonicalState(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length === 43 &&
      STATE_PATTERN.test(value)
    );
  }
}
