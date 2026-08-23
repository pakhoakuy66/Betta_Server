import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  readExactCorsOrigins,
  type AppEnvironment,
} from '../../../common/config/exact-origin.config';
import {
  GOOGLE_OAUTH_FRONTEND_CANCELLED_PATH,
  GOOGLE_OAUTH_FRONTEND_ERROR_PATH,
  GOOGLE_OAUTH_FRONTEND_LINK_PATH,
  GOOGLE_OAUTH_FRONTEND_REGISTRATION_PATH,
  GOOGLE_OAUTH_FRONTEND_SESSION_PATH,
  GOOGLE_OAUTH_FRONTEND_RESTRICTED_PATH,
} from '../constants/google-oauth-route.constants';
import type { PublicAccountRestriction } from '../../../common/security/public-account-restriction';

const DEFAULT_DEVELOPER_ORIGIN = 'http://localhost:5173';

export enum GoogleOAuthFrontendDestination {
  SESSION = 'SESSION',
  LINK = 'LINK',
  REGISTRATION = 'REGISTRATION',
  CANCELLED = 'CANCELLED',
  ERROR = 'ERROR',
  RESTRICTED = 'RESTRICTED',
}

const DESTINATION_PATHS: Readonly<
  Record<GoogleOAuthFrontendDestination, string>
> = {
  [GoogleOAuthFrontendDestination.SESSION]: GOOGLE_OAUTH_FRONTEND_SESSION_PATH,
  [GoogleOAuthFrontendDestination.LINK]: GOOGLE_OAUTH_FRONTEND_LINK_PATH,
  [GoogleOAuthFrontendDestination.REGISTRATION]:
    GOOGLE_OAUTH_FRONTEND_REGISTRATION_PATH,
  [GoogleOAuthFrontendDestination.CANCELLED]:
    GOOGLE_OAUTH_FRONTEND_CANCELLED_PATH,
  [GoogleOAuthFrontendDestination.ERROR]: GOOGLE_OAUTH_FRONTEND_ERROR_PATH,
  [GoogleOAuthFrontendDestination.RESTRICTED]:
    GOOGLE_OAUTH_FRONTEND_RESTRICTED_PATH,
};

@Injectable()
export class GoogleOAuthFrontendRedirectService {
  private readonly frontendOrigin: string;

  constructor(configService: ConfigService) {
    const environment = this.readEnvironment(
      configService.get<string>('NODE_ENV'),
    );

    const configuredOrigin = configService
      .get<string>('GOOGLE_OAUTH_FRONTEND_ORIGIN')
      ?.trim();

    if (environment === 'production' && !configuredOrigin) {
      throw new Error('GOOGLE_OAUTH_FRONTEND_ORIGIN is required in production');
    }

    const candidate = configuredOrigin || DEFAULT_DEVELOPER_ORIGIN;

    this.frontendOrigin = this.parseOrigin(candidate, environment);

    const allowedOrigins = new Set(readExactCorsOrigins(configService));

    if (!allowedOrigins.has(this.frontendOrigin)) {
      throw new Error(
        'GOOGLE_OAUTH_FRONTEND_ORIGIN must be present in CORS_ALLOWED_ORIGINS',
      );
    }
  }

  createUrl(destination: GoogleOAuthFrontendDestination): string {
    return new URL(
      DESTINATION_PATHS[destination],
      `${this.frontendOrigin}/`,
    ).toString();
  }

  createRestrictionUrl(restriction: PublicAccountRestriction): string {
    const url = this.createUrl(GoogleOAuthFrontendDestination.RESTRICTED);
    const fragment = Buffer.from(JSON.stringify(restriction), 'utf8').toString(
      'base64url',
    );
    return `${url}#restriction=${fragment}`;
  }

  private readEnvironment(value: string | undefined): AppEnvironment {
    const environment = value?.trim() || 'developer';

    if (
      environment !== 'developer' &&
      environment !== 'test' &&
      environment !== 'production'
    ) {
      throw new Error('NODE_ENV must be developer, test, or production');
    }

    return environment;
  }

  private parseOrigin(candidate: string, environment: AppEnvironment): string {
    let url: URL;

    try {
      url = new URL(candidate);
    } catch {
      throw new Error('GOOGLE_OAUTH_FRONTEND_ORIGIN must be an exact origin');
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('GOOGLE_OAUTH_FRONTEND_ORIGIN must be an exact origin');
    }

    if (environment === 'production' && url.protocol !== 'https:') {
      throw new Error('Production Google OAuth frontend origin must use HTTPS');
    }

    return url.origin;
  }
}
