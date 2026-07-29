import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

import { GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BASE64URL_LENGTH } from '../constants/google-oauth-session-handoff.constants';
import { GOOGLE_OAUTH_SESSION_PATH } from '../constants/google-oauth-route.constants';
import { GoogleOAuthSessionHandoffCookieInvalidException } from '../exceptions/google-oauth-session-handoff-cookie-invalid.exception';
import { GoogleOAuthSessionHandoffInvalidException } from '../exceptions/google-oauth-session-handoff-invalid.exception';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';

const COOKIE_NAME = 'betta_google_session_handoff';
const RAW_HANDOFF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type SameSitePolicy = 'lax' | 'none';
type AppEnvironment = 'developer' | 'test' | 'production';

@Injectable()
export class GoogleOAuthSessionHandoffCookieService {
  private readonly secure: boolean;
  private readonly sameSite: SameSitePolicy;

  constructor(configService: ConfigService) {
    const environment = this.readEnvironment(
      configService.get<string>('NODE_ENV'),
    );

    this.sameSite = this.readSameSitePolicy(
      configService.get<string>(
        'GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE',
      ),
    );

    this.secure = environment === 'production';

    if (this.sameSite === 'none' && !this.secure) {
      throw new Error(
        'SameSite=None requires NODE_ENV=production and Secure=true',
      );
    }
  }

  write(response: Response, handoff: IssuedGoogleOAuthSessionHandoff): void {
    if (!this.isCanonicalRawHandoff(handoff.rawHandoff)) {
      throw new TypeError('Invalid issued Google OAuth session handoff');
    }

    const expiresAtMs = handoff.expiresAt.getTime();
    const maxAge = expiresAtMs - Date.now();

    if (!Number.isFinite(expiresAtMs) || maxAge <= 0) {
      throw new TypeError('Google OAuth session handoff has expired');
    }

    response.cookie(COOKIE_NAME, handoff.rawHandoff, {
      ...this.options(),
      expires: handoff.expiresAt,
      maxAge,
    });
  }

  read(request: Request): string {
    let rawHandoff: string | undefined;

    try {
      rawHandoff = parse(request.headers.cookie ?? '')[COOKIE_NAME];
    } catch {
      throw new GoogleOAuthSessionHandoffCookieInvalidException();
    }

    if (!this.isCanonicalRawHandoff(rawHandoff)) {
      throw new GoogleOAuthSessionHandoffCookieInvalidException();
    }

    return rawHandoff;
  }

  clear(response: Response): void {
    response.clearCookie(COOKIE_NAME, this.options());
  }

  shouldClearAfterError(error: unknown): boolean {
    return (
      error instanceof GoogleOAuthSessionHandoffCookieInvalidException ||
      error instanceof GoogleOAuthSessionHandoffInvalidException
    );
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: this.sameSite,
      path: GOOGLE_OAUTH_SESSION_PATH,
      priority: 'high',
    };
  }

  private readEnvironment(value: string | undefined): AppEnvironment {
    const environment = value ?? 'developer';

    if (
      environment !== 'developer' &&
      environment !== 'test' &&
      environment !== 'production'
    ) {
      throw new Error('NODE_ENV must be developer, test, or production');
    }

    return environment;
  }

  private readSameSitePolicy(value: string | undefined): SameSitePolicy {
    const sameSite = value ?? 'lax';

    if (sameSite !== 'lax' && sameSite !== 'none') {
      throw new Error(
        'GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE must be lax or none',
      );
    }

    return sameSite;
  }

  private isCanonicalRawHandoff(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length === GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BASE64URL_LENGTH &&
      RAW_HANDOFF_PATTERN.test(value)
    );
  }
}
