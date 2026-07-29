import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

import { GOOGLE_OAUTH_SESSION_PATH } from '../constants/google-oauth-route.constants';
import { GoogleOAuthSessionHandoffCookieInvalidException } from '../exceptions/google-oauth-session-handoff-cookie-invalid.exception';
import { GoogleOAuthSessionHandoffInvalidException } from '../exceptions/google-oauth-session-handoff-invalid.exception';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';
import { GoogleOAuthSessionHandoffCookieService } from './google-oauth-session-handoff-cookie.service';

const RAW_HANDOFF = Buffer.alloc(32, 7).toString('base64url');
const NOW = new Date('2026-07-26T00:00:00.000Z');
const EXPIRES_AT = new Date(NOW.getTime() + 120_000);

type CookieWriter = (
  name: string,
  value: string,
  options: CookieOptions,
) => void;

type CookieClearer = (name: string, options: CookieOptions) => void;

const createContext = (overrides: Record<string, string | undefined> = {}) => {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE: 'lax',
    ...overrides,
  };

  const configService = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  const cookie = jest.fn<CookieWriter>();
  const clearCookie = jest.fn<CookieClearer>();
  const response = {
    cookie,
    clearCookie,
  } as unknown as Response;

  return {
    service: new GoogleOAuthSessionHandoffCookieService(configService),
    response,
    cookie,
    clearCookie,
  };
};

const createRequest = (cookieHeader?: string): Request =>
  ({
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  }) as Request;

describe('GoogleOAuthSessionHandoffCookieService', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes a scoped HttpOnly host-only cookie', () => {
    const { service, response, cookie } = createContext();

    const handoff: IssuedGoogleOAuthSessionHandoff = {
      rawHandoff: RAW_HANDOFF,
      expiresAt: EXPIRES_AT,
    };

    service.write(response, handoff);

    expect(cookie).toHaveBeenCalledWith(
      'betta_google_session_handoff',
      RAW_HANDOFF,
      {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: GOOGLE_OAUTH_SESSION_PATH,
        priority: 'high',
        expires: EXPIRES_AT,
        maxAge: 120_000,
      },
    );

    const options = cookie.mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('domain');
  });

  it('uses Secure=true in production', () => {
    const { service, response, cookie } = createContext({
      NODE_ENV: 'production',
    });

    service.write(response, {
      rawHandoff: RAW_HANDOFF,
      expiresAt: EXPIRES_AT,
    });

    expect(cookie.mock.calls[0]?.[2]).toMatchObject({
      secure: true,
    });
  });

  it('calculates Max-Age from remaining lifetime', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime() + 30_000);

    const { service, response, cookie } = createContext();

    service.write(response, {
      rawHandoff: RAW_HANDOFF,
      expiresAt: EXPIRES_AT,
    });

    expect(cookie.mock.calls[0]?.[2]).toMatchObject({
      maxAge: 90_000,
    });
  });

  it.each([
    '',
    'not-base64url',
    Buffer.alloc(31, 1).toString('base64url'),
    Buffer.alloc(33, 1).toString('base64url'),
  ])('rejects invalid issued handoff: %s', (rawHandoff) => {
    const { service, response, cookie } = createContext();

    expect(() =>
      service.write(response, {
        rawHandoff,
        expiresAt: EXPIRES_AT,
      }),
    ).toThrow(TypeError);

    expect(cookie).not.toHaveBeenCalled();
  });

  it('does not write an expired handoff', () => {
    const { service, response, cookie } = createContext();

    expect(() =>
      service.write(response, {
        rawHandoff: RAW_HANDOFF,
        expiresAt: NOW,
      }),
    ).toThrow(TypeError);

    expect(cookie).not.toHaveBeenCalled();
  });

  it('reads the canonical raw handoff', () => {
    const { service } = createContext();

    expect(
      service.read(
        createRequest(
          `other=value; betta_google_session_handoff=${RAW_HANDOFF}`,
        ),
      ),
    ).toBe(RAW_HANDOFF);
  });

  it.each([
    undefined,
    'other=value',
    'betta_google_session_handoff=malformed',
    'betta_google_session_handoff=%',
  ])('rejects a missing or malformed cookie', (header) => {
    const { service } = createContext();

    expect(() => service.read(createRequest(header))).toThrow(
      GoogleOAuthSessionHandoffCookieInvalidException,
    );
  });

  it('clears with the same transport attributes', () => {
    const { service, response, clearCookie } = createContext();

    service.clear(response);

    expect(clearCookie).toHaveBeenCalledWith('betta_google_session_handoff', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: GOOGLE_OAUTH_SESSION_PATH,
      priority: 'high',
    });

    const options = clearCookie.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('expires');
    expect(options).not.toHaveProperty('maxAge');
    expect(options).not.toHaveProperty('domain');
  });

  it('clears only definitive cookie or handoff errors', () => {
    const { service } = createContext();

    expect(
      service.shouldClearAfterError(
        new GoogleOAuthSessionHandoffCookieInvalidException(),
      ),
    ).toBe(true);

    expect(
      service.shouldClearAfterError(
        new GoogleOAuthSessionHandoffInvalidException(),
      ),
    ).toBe(true);

    expect(service.shouldClearAfterError(new ConflictException())).toBe(false);

    expect(
      service.shouldClearAfterError(new ServiceUnavailableException()),
    ).toBe(false);

    expect(service.shouldClearAfterError(new Error('unknown'))).toBe(false);
  });

  it.each(['strict', 'true', 'None'])(
    'rejects invalid SameSite policy: %s',
    (sameSite) => {
      expect(() =>
        createContext({
          GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE: sameSite,
        }),
      ).toThrow(
        'GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE must be lax or none',
      );
    },
  );

  it('rejects SameSite=None outside production', () => {
    expect(() =>
      createContext({
        GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow('SameSite=None requires NODE_ENV=production and Secure=true');
  });

  it('writes SameSite=None only with Secure=true', () => {
    const { service, response, cookie } = createContext({
      NODE_ENV: 'production',
      GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE: 'none',
    });

    service.write(response, {
      rawHandoff: RAW_HANDOFF,
      expiresAt: EXPIRES_AT,
    });

    expect(cookie.mock.calls[0]?.[2]).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: GOOGLE_OAUTH_SESSION_PATH,
    });
  });

  it.each(['development', 'prod', 'staging'])(
    'rejects unsupported NODE_ENV: %s',
    (environment) => {
      expect(() =>
        createContext({
          NODE_ENV: environment,
        }),
      ).toThrow('NODE_ENV must be developer, test, or production');
    },
  );
});
