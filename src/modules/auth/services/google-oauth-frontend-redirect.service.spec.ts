import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import {
  GoogleOAuthFrontendDestination,
  GoogleOAuthFrontendRedirectService,
} from './google-oauth-frontend-redirect.service';

const createService = (values: Record<string, string | undefined>) =>
  new GoogleOAuthFrontendRedirectService({
    get: jest.fn((key: string): string | undefined => values[key]),
  } as unknown as ConfigService);

describe('GoogleOAuthFrontendRedirectService', () => {
  it('creates only fixed developer destinations', () => {
    const service = createService({
      NODE_ENV: 'developer',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      GOOGLE_OAUTH_FRONTEND_ORIGIN: 'http://localhost:5173',
    });

    expect(service.createUrl(GoogleOAuthFrontendDestination.SESSION)).toBe(
      'http://localhost:5173/auth/google/session',
    );

    expect(service.createUrl(GoogleOAuthFrontendDestination.ERROR)).toBe(
      'http://localhost:5173/auth/google/error',
    );
  });

  it('accepts an HTTPS production origin', () => {
    expect(() =>
      createService({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.betta.example',
        GOOGLE_OAUTH_FRONTEND_ORIGIN: 'https://app.betta.example',
      }),
    ).not.toThrow();
  });

  it('requires an explicit production origin', () => {
    expect(() =>
      createService({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.betta.example',
      }),
    ).toThrow('GOOGLE_OAUTH_FRONTEND_ORIGIN is required in production');
  });

  it.each([
    'http://app.betta.example',
    'https://user:pass@app.betta.example',
    'https://app.betta.example/path',
    'https://app.betta.example?x=1',
    'https://app.betta.example#fragment',
  ])('rejects an unsafe production origin: %s', (origin) => {
    expect(() =>
      createService({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: origin,
        GOOGLE_OAUTH_FRONTEND_ORIGIN: origin,
      }),
    ).toThrow();
  });

  it('requires the redirect origin in CORS allowlist', () => {
    expect(() =>
      createService({
        NODE_ENV: 'developer',
        CORS_ALLOWED_ORIGINS: 'http://localhost:5174',
        GOOGLE_OAUTH_FRONTEND_ORIGIN: 'http://localhost:5173',
      }),
    ).toThrow(
      'GOOGLE_OAUTH_FRONTEND_ORIGIN must be present in CORS_ALLOWED_ORIGINS',
    );
  });
});
