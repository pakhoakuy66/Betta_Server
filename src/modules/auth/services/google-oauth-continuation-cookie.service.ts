import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

import { GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH } from '../constants/google-oauth-continuation-grant.constants';
import { GoogleOAuthContinuationCookieInvalidException } from '../exceptions/google-oauth-continuation-cookie-invalid.exception';
import type { IssuedGoogleOAuthContinuationGrant } from '../interfaces/google-oauth-continuation-grant.interface';
import { GoogleOAuthContinuationGrantPurpose } from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationGrantRejectedException } from '../exceptions/google-oauth-continuation-grant-rejected.exception';

const RAW_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type CookieDefinition = {
  name: string;
  path: string;
};

const COOKIE_DEFINITIONS: Record<
  GoogleOAuthContinuationGrantPurpose,
  CookieDefinition
> = {
  [GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT]: {
    name: 'betta_google_link_grant',
    path: '/api/v1/auth/google/continuation/link',
  },
  [GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION]: {
    name: 'betta_google_registration_grant',
    path: '/api/v1/auth/google/continuation/registration',
  },
};

@Injectable()
export class GoogleOAuthContinuationCookieService {
  private readonly secure: boolean;
  private readonly sameSite: 'lax' | 'none';

  constructor(configService: ConfigService) {
    const environment = configService.get<string>('NODE_ENV') ?? 'developer';

    const configuredSameSite =
      configService.get<string>('GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE') ??
      'lax';

    if (configuredSameSite !== 'lax' && configuredSameSite !== 'none') {
      throw new Error(
        'GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE phải là lax hoặc none',
      );
    }

    this.secure = environment === 'production';
    this.sameSite = configuredSameSite;

    if (this.sameSite === 'none' && !this.secure) {
      throw new Error('SameSite=None yêu cầu Secure=true');
    }
  }

  write(
    response: Response,
    purpose: GoogleOAuthContinuationGrantPurpose,
    grant: IssuedGoogleOAuthContinuationGrant,
  ): void {
    if (!this.isCanonicalRawGrant(grant.rawGrant)) {
      throw new TypeError('Invalid issued continuation grant');
    }

    const maxAge = grant.expiresAt.getTime() - Date.now();

    if (maxAge <= 0) {
      throw new TypeError('Continuation grant đã hết hạn');
    }

    const definition = COOKIE_DEFINITIONS[purpose];

    response.cookie(definition.name, grant.rawGrant, {
      ...this.options(purpose),
      expires: grant.expiresAt,
      maxAge,
    });
  }

  read(request: Request, purpose: GoogleOAuthContinuationGrantPurpose): string {
    let rawGrant: string | undefined;

    try {
      rawGrant = parse(request.headers.cookie ?? '')[
        COOKIE_DEFINITIONS[purpose].name
      ];
    } catch {
      throw new GoogleOAuthContinuationCookieInvalidException();
    }

    if (!this.isCanonicalRawGrant(rawGrant)) {
      throw new GoogleOAuthContinuationCookieInvalidException();
    }

    return rawGrant;
  }

  clear(
    response: Response,
    purpose: GoogleOAuthContinuationGrantPurpose,
  ): void {
    response.clearCookie(
      COOKIE_DEFINITIONS[purpose].name,
      this.options(purpose),
    );
  }

  shouldClearAfterError(error: unknown): boolean {
    return (
      error instanceof GoogleOAuthContinuationCookieInvalidException ||
      error instanceof GoogleOAuthContinuationGrantRejectedException
    );
  }

  private options(purpose: GoogleOAuthContinuationGrantPurpose): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: this.sameSite,
      path: COOKIE_DEFINITIONS[purpose].path,
      priority: 'high',
    };
  }

  private isCanonicalRawGrant(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length === GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH &&
      RAW_GRANT_PATTERN.test(value)
    );
  }
}
