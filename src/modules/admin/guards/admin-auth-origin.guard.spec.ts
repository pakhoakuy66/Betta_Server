import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthOriginGuard } from './admin-auth-origin.guard';

const contextFor = (origin?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () =>
        ({
          get: (name: string) => (name === 'origin' ? origin : undefined),
        }) as Request | undefined,
    }),
  }) as unknown as ExecutionContext;

describe('AdminAuthOriginGuard', () => {
  const config = {
    get: (key: string): string | undefined => {
      if (key === 'NODE_ENV') return 'production';
      if (key === 'CORS_ALLOWED_ORIGINS') {
        return 'https://admin.betta.test,https://ops.betta.test';
      }
      return undefined;
    },
  } as ConfigService;

  it('allows only an exact configured origin', () => {
    const guard = new AdminAuthOriginGuard(config);

    expect(guard.canActivate(contextFor('https://admin.betta.test'))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor('https://admin.betta.test.evil.example')),
    ).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor())).toThrow(ForbiddenException);
  });
});
