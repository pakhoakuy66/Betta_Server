import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { CookieOptions, Request, Response } from 'express';

import { GOOGLE_OAUTH_CALLBACK_PATH } from '../constants/google-oauth-route.constants';
import { GoogleOAuthStateCookieInvalidException } from '../exceptions/google-oauth-state-cookie-invalid.exception';
import { GoogleOAuthStateCookieService } from './google-oauth-state-cookie.service';

const STATE = 'a'.repeat(43);
const NOW = new Date('2026-07-25T00:00:00.000Z');

type SetCookieMock = (
  name: string,
  value: string,
  options: CookieOptions,
) => Response;

type ClearCookieMock = (name: string, options?: CookieOptions) => Response;

const createContext = (environment = 'developer') => {
  const cookie = jest.fn<SetCookieMock>();
  const clearCookie = jest.fn<ClearCookieMock>();

  const service = new GoogleOAuthStateCookieService({
    get: jest.fn((key: string) =>
      key === 'NODE_ENV' ? environment : undefined,
    ),
  } as unknown as ConfigService);

  return {
    service,
    cookie,
    clearCookie,
    response: { cookie, clearCookie } as unknown as Response,
  };
};

describe('GoogleOAuthStateCookieService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes a scoped HttpOnly state cookie', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    const context = createContext();
    const expiresAt = new Date(NOW.getTime() + 600_000);

    context.service.write(context.response, STATE, expiresAt);

    expect(context.cookie).toHaveBeenCalledWith(
      'betta_google_oauth_state',
      STATE,
      {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: GOOGLE_OAUTH_CALLBACK_PATH,
        priority: 'high',
        expires: expiresAt,
        maxAge: 600_000,
      },
    );
  });

  it('uses Secure and remains host-only in production', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    const context = createContext('production');

    context.service.write(
      context.response,
      STATE,
      new Date(NOW.getTime() + 60_000),
    );

    const cookieOptions = context.cookie.mock.calls[0]?.[2];

    expect(cookieOptions).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: GOOGLE_OAUTH_CALLBACK_PATH,
    });

    expect(cookieOptions).not.toHaveProperty('domain');
  });

  it.each(['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'bad+state'])(
    'rejects malformed state: %s',
    (state) => {
      const context = createContext();

      expect(() =>
        context.service.write(
          context.response,
          state,
          new Date(Date.now() + 60_000),
        ),
      ).toThrow(TypeError);

      expect(context.cookie).not.toHaveBeenCalled();
    },
  );

  it.each([new Date(Date.now() - 1), new Date(Number.NaN)])(
    'rejects invalid or expired expiry',
    (expiresAt) => {
      const context = createContext();

      expect(() =>
        context.service.write(context.response, STATE, expiresAt),
      ).toThrow(TypeError);

      expect(context.cookie).not.toHaveBeenCalled();
    },
  );

  it('reads only the authorization-state cookie', () => {
    const context = createContext();

    const request = {
      headers: {
        cookie: `other=value; betta_google_oauth_state=${STATE}`,
      },
    } as unknown as Request;

    expect(context.service.read(request)).toBe(STATE);
  });

  it.each([undefined, '', 'betta_google_oauth_state=invalid'])(
    'rejects missing or malformed state cookie',
    (cookieHeader) => {
      const context = createContext();

      const request = {
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      } as unknown as Request;

      expect(() => context.service.read(request)).toThrow(
        GoogleOAuthStateCookieInvalidException,
      );
    },
  );

  it('clears using the exact cookie transport contract', () => {
    const context = createContext('production');

    context.service.clear(context.response);

    expect(context.clearCookie).toHaveBeenCalledWith(
      'betta_google_oauth_state',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: GOOGLE_OAUTH_CALLBACK_PATH,
        priority: 'high',
      },
    );

    const clearOptions = context.clearCookie.mock.calls[0]?.[1];

    expect(clearOptions).not.toHaveProperty('domain');
    expect(clearOptions).not.toHaveProperty('expires');
    expect(clearOptions).not.toHaveProperty('maxAge');
  });

  it('rejects an unsupported environment', () => {
    expect(() => createContext('development')).toThrow(
      'NODE_ENV phải là developer, test hoặc production',
    );
  });
});
