import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
} from '../constants/admin-auth-transport.constants';
import { type AdminAuthenticationResult } from '../interfaces/admin-auth.interface';
import { AdminAuthCookieService } from './admin-auth-cookie.service';

const createConfig = (environment: string, sameSite?: string): ConfigService =>
  ({
    get: (key: string): string | undefined => {
      if (key === 'NODE_ENV') return environment;
      if (key === 'ADMIN_AUTH_COOKIE_SAME_SITE') return sameSite;
      return undefined;
    },
  }) as ConfigService;

const authentication = (): AdminAuthenticationResult => ({
  accessToken: 'admin-access-token',
  refreshToken: 'admin-refresh-token',
  refreshTokenExpiresAt: new Date(Date.now() + 60_000),
  sessionPublicId: 'ases_23456789ABCDEFGH',
  admin: {
    id: 'adm_23456789ABCD',
    publicId: 'adm_23456789ABCD',
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
  },
});

describe('AdminAuthCookieService', () => {
  let cookie: jest.Mock;
  let clearCookie: jest.Mock;
  let response: Response;

  beforeEach(() => {
    cookie = jest.fn();
    clearCookie = jest.fn();
    response = { cookie, clearCookie } as unknown as Response;
  });

  it('writes separate production refresh and CSRF cookies with strict flags', () => {
    const service = new AdminAuthCookieService(
      createConfig('production', 'strict'),
    );

    const csrfToken = service.writeSession(response, authentication());

    expect(cookie).toHaveBeenCalledTimes(2);
    expect(cookie).toHaveBeenNthCalledWith(
      1,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
      'admin-refresh-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        priority: 'high',
      }),
    );
    expect(cookie).toHaveBeenNthCalledWith(
      2,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      }),
    );
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(cookie.mock.calls[1]?.[1]).toBe(csrfToken);
  });

  it('accepts an exact double-submit token and rejects mismatch', () => {
    const service = new AdminAuthCookieService(createConfig('production'));
    service.writeSession(response, authentication());
    const csrfToken = cookie.mock.calls[1]?.[1] as string;
    const validRequest = {
      headers: {
        cookie: `${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=${csrfToken}`,
        [ADMIN_CSRF_HEADER_NAME]: csrfToken,
      },
    } as unknown as Request;

    expect(() => service.assertCsrf(validRequest)).not.toThrow();

    const invalidRequest = {
      headers: {
        cookie: `${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=${csrfToken}`,
        [ADMIN_CSRF_HEADER_NAME]: 'A'.repeat(43),
      },
    } as unknown as Request;
    expect(() => service.assertCsrf(invalidRequest)).toThrow(
      ForbiddenException,
    );
  });

  it('rejects duplicate refresh cookies instead of accepting ambiguity', () => {
    const service = new AdminAuthCookieService(createConfig('production'));
    const request = {
      headers: {
        cookie:
          `${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=first; ` +
          `${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=second`,
      },
    } as unknown as Request;

    expect(() => service.readRefreshCredential(request)).toThrow(
      UnauthorizedException,
    );
  });

  it('bootstraps CSRF proof only when both host-only cookies are valid', () => {
    const service = new AdminAuthCookieService(createConfig('production'));
    const csrfToken = service.writeSession(response, authentication());
    const request = {
      headers: {
        cookie:
          `${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=admin-refresh-token; ` +
          `${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=${csrfToken}`,
      },
    } as unknown as Request;

    expect(service.readCsrfBootstrapProof(request)).toBe(csrfToken);

    const missingRefresh = {
      headers: {
        cookie: `${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=${csrfToken}`,
      },
    } as unknown as Request;
    expect(() => service.readCsrfBootstrapProof(missingRefresh)).toThrow(
      UnauthorizedException,
    );
  });

  it('clears cookies using the same production contract', () => {
    const service = new AdminAuthCookieService(createConfig('production'));

    service.clearSession(response);

    expect(clearCookie).toHaveBeenNthCalledWith(
      1,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      }),
    );
    expect(clearCookie).toHaveBeenNthCalledWith(
      2,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
  });

  it('fails fast for an unsafe SameSite=None developer configuration', () => {
    expect(
      () => new AdminAuthCookieService(createConfig('developer', 'none')),
    ).toThrow('ADMIN_AUTH_COOKIE_SAME_SITE=none');
  });

  it('allows SameSite=None only for a secure cross-site production deployment', () => {
    const service = new AdminAuthCookieService(
      createConfig('production', 'none'),
    );

    service.writeSession(response, authentication());

    expect(cookie).toHaveBeenNthCalledWith(
      1,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
      'admin-refresh-token',
      expect.objectContaining({ secure: true, sameSite: 'none' }),
    );
  });
});
