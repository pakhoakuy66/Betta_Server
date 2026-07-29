import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Request, Response } from 'express';

import { GoogleOAuthContinuationCookieInvalidException } from '../exceptions/google-oauth-continuation-cookie-invalid.exception';
import { GoogleOAuthContinuationGrantInvalidException } from '../exceptions/google-oauth-continuation-grant-invalid.exception';
import { GoogleOAuthContinuationGrantPurpose } from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationCookieService } from './google-oauth-continuation-cookie.service';
import { GoogleOAuthContinuationGrantRejectedException } from '../exceptions/google-oauth-continuation-grant-rejected.exception';

const RAW_GRANT = 'a'.repeat(43);
const NOW = new Date('2026-07-24T00:00:00.000Z');
const EXPIRES_AT = new Date(NOW.getTime() + 600_000);

type ConfigValues = Record<string, string>;

const createService = (
  values: ConfigValues = {},
): GoogleOAuthContinuationCookieService => {
  const configService = {
    get: jest.fn((key: string): string | undefined => values[key]),
  } as unknown as ConfigService;

  return new GoogleOAuthContinuationCookieService(configService);
};

const createResponse = () => {
  const cookie = jest.fn();
  const clearCookie = jest.fn();

  return {
    cookie,
    clearCookie,
    response: {
      cookie,
      clearCookie,
    } as unknown as Response,
  };
};

const createRequest = (cookie?: string): Request =>
  ({
    headers: cookie === undefined ? {} : { cookie },
  }) as unknown as Request;

describe('GoogleOAuthContinuationCookieService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    [
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      'betta_google_link_grant',
      '/api/v1/auth/google/continuation/link',
    ],
    [
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      'betta_google_registration_grant',
      '/api/v1/auth/google/continuation/registration',
    ],
  ])(
    'writes a purpose-scoped HttpOnly cookie for %s',
    (purpose, expectedName, expectedPath) => {
      const service = createService();
      const { response, cookie } = createResponse();

      service.write(response, purpose, {
        rawGrant: RAW_GRANT,
        expiresAt: EXPIRES_AT,
      });

      expect(cookie).toHaveBeenCalledWith(expectedName, RAW_GRANT, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: expectedPath,
        priority: 'high',
        expires: EXPIRES_AT,
        maxAge: 600_000,
      });
    },
  );

  it('uses Secure cookies in production', () => {
    const service = createService({
      NODE_ENV: 'production',
    });
    const { response, cookie } = createResponse();

    service.write(response, GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT, {
      rawGrant: RAW_GRANT,
      expiresAt: EXPIRES_AT,
    });

    expect(cookie).toHaveBeenCalledWith(
      'betta_google_link_grant',
      RAW_GRANT,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
  });

  it('accepts SameSite=None only in production', () => {
    const service = createService({
      NODE_ENV: 'production',
      GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE: 'none',
    });
    const { response, cookie } = createResponse();

    service.write(
      response,
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      {
        rawGrant: RAW_GRANT,
        expiresAt: EXPIRES_AT,
      },
    );

    expect(cookie).toHaveBeenCalledWith(
      'betta_google_registration_grant',
      RAW_GRANT,
      expect.objectContaining({
        secure: true,
        sameSite: 'none',
      }),
    );
  });

  it('rejects SameSite=None outside production', () => {
    expect(() =>
      createService({
        NODE_ENV: 'developer',
        GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow('SameSite=None yêu cầu Secure=true');
  });

  it.each(['NONE', 'None', 'strict', 'invalid', 'none '])(
    'rejects invalid SameSite configuration: %s',
    (sameSite) => {
      expect(() =>
        createService({
          GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE: sameSite,
        }),
      ).toThrow(
        'GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE phải là lax hoặc none',
      );
    },
  );

  it('does not write an expired grant cookie', () => {
    const service = createService();
    const { response, cookie } = createResponse();

    expect(() =>
      service.write(
        response,
        GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        {
          rawGrant: RAW_GRANT,
          expiresAt: new Date(NOW.getTime() - 1),
        },
      ),
    ).toThrow('Continuation grant đã hết hạn');

    expect(cookie).not.toHaveBeenCalled();
  });

  it('does not write a malformed internal grant', () => {
    const service = createService();
    const { response, cookie } = createResponse();

    expect(() =>
      service.write(
        response,
        GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        {
          rawGrant: 'invalid',
          expiresAt: EXPIRES_AT,
        },
      ),
    ).toThrow(TypeError);

    expect(cookie).not.toHaveBeenCalled();
  });

  it('reads the exact cookie for the requested purpose', () => {
    const service = createService();

    const result = service.read(
      createRequest(`other=value; betta_google_link_grant=${RAW_GRANT}`),
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
    );

    expect(result).toBe(RAW_GRANT);
  });

  it.each([
    [undefined],
    ['other=value'],
    [`betta_google_link_grant=${'a'.repeat(42)}`],
    [`betta_google_link_grant=${'a'.repeat(42)}+`],
    [`betta_google_registration_grant=${RAW_GRANT}`],
    ['betta_google_link_grant=%E0%A4%A'],
  ])('rejects a missing or malformed link cookie', (cookieHeader) => {
    const service = createService();

    expect(() =>
      service.read(
        createRequest(cookieHeader),
        GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      ),
    ).toThrow(GoogleOAuthContinuationCookieInvalidException);
  });

  it('clears with the same cookie scope without expiry options', () => {
    const service = createService({
      NODE_ENV: 'production',
    });
    const { response, clearCookie } = createResponse();

    service.clear(
      response,
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
    );

    expect(clearCookie).toHaveBeenCalledWith(
      'betta_google_registration_grant',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth/google/continuation/registration',
        priority: 'high',
      },
    );
  });

  it.each([
    [
      'cookie-invalid',
      new GoogleOAuthContinuationCookieInvalidException(),
      true,
    ],
    [
      'definitively rejected grant',
      new GoogleOAuthContinuationGrantRejectedException(),
      true,
    ],
    [
      'generic grant-invalid',
      new GoogleOAuthContinuationGrantInvalidException(),
      false,
    ],
    ['conflict', new ConflictException(), false],
    ['server error', new ServiceUnavailableException(), false],
    ['unknown error', new Error('unknown'), false],
  ])(
    'returns the correct clear policy for %s',
    (_caseName, error, expected) => {
      const service = createService();

      expect(service.shouldClearAfterError(error)).toBe(expected);
    },
  );
});
