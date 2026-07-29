import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';

import { GoogleOAuthContinuationOriginGuard } from './google-oauth-continuation-origin.guard';

const createGuard = (values: Record<string, string>) => {
  const configService = {
    get: jest.fn((key: string): string | undefined => values[key]),
  } as unknown as ConfigService;

  return new GoogleOAuthContinuationOriginGuard(configService);
};

const createContext = (origin?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        get: (name: string) =>
          name.toLowerCase() === 'origin' ? origin : undefined,
      }),
    }),
  }) as unknown as ExecutionContext;

describe('GoogleOAuthContinuationOriginGuard', () => {
  it.each(['lax', 'none'])(
    'accepts exact Origin with SameSite=%s',
    (sameSite) => {
      const guard = createGuard({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.betta.com',
        GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE: sameSite,
      });

      expect(guard.canActivate(createContext('https://app.betta.com'))).toBe(
        true,
      );
    },
  );

  it('rejects a missing Origin', () => {
    const guard = createGuard({
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    });

    expect(() => guard.canActivate(createContext())).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an unknown Origin', () => {
    const guard = createGuard({
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    });

    expect(() =>
      guard.canActivate(createContext('http://localhost:5174')),
    ).toThrow(ForbiddenException);
  });

  it.each([
    '*',
    'https://user:pass@app.betta.com',
    'https://app.betta.com/path',
    'https://app.betta.com?query=1',
    'https://app.betta.com#fragment',
  ])('rejects invalid origin config: %s', (origin) => {
    expect(() =>
      createGuard({
        CORS_ALLOWED_ORIGINS: origin,
      }),
    ).toThrow();
  });

  it('requires origins in production', () => {
    expect(() =>
      createGuard({
        NODE_ENV: 'production',
      }),
    ).toThrow('CORS_ALLOWED_ORIGINS là bắt buộc trong production');
  });

  it('rejects HTTP origin in production', () => {
    expect(() =>
      createGuard({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'http://app.betta.com',
      }),
    ).toThrow('Production CORS origins phải dùng HTTPS');
  });
});
