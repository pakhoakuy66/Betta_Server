import {
  HttpException,
  HttpStatus,
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Server } from 'node:http';
import request from 'supertest';

import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { GOOGLE_OAUTH_START_PATH } from '../../src/modules/auth/constants/google-oauth-route.constants';
import { GoogleOAuthAuthorizationController } from '../../src/modules/auth/controllers/google-oauth-authorization.controller';
import { AuthRateLimitService } from '../../src/modules/auth/services/auth-rate-limit.service';
import { GoogleOAuthStateCookieService } from '../../src/modules/auth/services/google-oauth-state-cookie.service';
import { GoogleOAuthTransactionService } from '../../src/modules/auth/services/google-oauth-transaction.service';

const BROWSER_STATE = 'a'.repeat(43);

const AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/v2/auth' + `?state=${BROWSER_STATE}`;

const consumeGoogleOAuthStart =
  jest.fn<AuthRateLimitService['consumeGoogleOAuthStart']>();

const beginAuthorization =
  jest.fn<GoogleOAuthTransactionService['beginAuthorization']>();

describe('Google OAuth authorization-start HTTP transport', () => {
  let app: INestApplication;
  let httpServer: Server;
  let stateCookieService: GoogleOAuthStateCookieService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GoogleOAuthAuthorizationController],
      providers: [
        GoogleOAuthStateCookieService,
        {
          provide: AuthRateLimitService,
          useValue: {
            consumeGoogleOAuthStart,
          },
        },
        {
          provide: GoogleOAuthTransactionService,
          useValue: {
            beginAuthorization,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string): unknown =>
              key === 'NODE_ENV' ? 'test' : undefined,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    app.setGlobalPrefix('api/v1');

    app.useGlobalFilters(new ApiExceptionFilter());

    await app.init();

    httpServer = app.getHttpServer() as Server;

    stateCookieService = app.get(GoogleOAuthStateCookieService);
  });

  beforeEach(() => {
    consumeGoogleOAuthStart.mockReset().mockResolvedValue();

    beginAuthorization.mockReset().mockResolvedValue({
      authorizationUrl: AUTHORIZATION_URL,
      browserState: BROWSER_STATE,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is registered in AuthModule', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      AuthModule,
    ) as unknown[];

    expect(controllers).toContain(GoogleOAuthAuthorizationController);
  });

  it('writes the state cookie and redirects with an empty body', async () => {
    const writeSpy = jest.spyOn(stateCookieService, 'write');

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_START_PATH)
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(response.headers.location).toBe(AUTHORIZATION_URL);

    const rawCookies = response.headers['set-cookie'];

    const serializedCookies = Array.isArray(rawCookies)
      ? rawCookies.join('\n')
      : String(rawCookies ?? '');

    expect(serializedCookies).toContain(
      `betta_google_oauth_state=${BROWSER_STATE}`,
    );
    expect(serializedCookies).toContain('Path=/api/v1/auth/google/callback');
    expect(serializedCookies).toContain('HttpOnly');
    expect(serializedCookies).toContain('SameSite=Lax');
    expect(serializedCookies).not.toContain('Domain=');

    expect(response.headers['cache-control']).toContain('no-store');

    expect(response.headers['referrer-policy']).toBe('no-referrer');

    expect(response.text).toBe('');

    expect(consumeGoogleOAuthStart).toHaveBeenCalledTimes(1);

    expect(beginAuthorization).toHaveBeenCalledTimes(1);

    expect(writeSpy).toHaveBeenCalledWith(
      expect.anything(),
      BROWSER_STATE,
      expect.any(Date),
    );

    expect(consumeGoogleOAuthStart.mock.invocationCallOrder[0]).toBeLessThan(
      beginAuthorization.mock.invocationCallOrder[0],
    );

    expect(beginAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );
  });

  it('does not create a transaction or redirect when rate limited', async () => {
    consumeGoogleOAuthStart.mockRejectedValueOnce(
      new HttpException('Quá nhiều yêu cầu', HttpStatus.TOO_MANY_REQUESTS),
    );

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_START_PATH)
      .redirects(0)
      .expect(HttpStatus.TOO_MANY_REQUESTS);

    expect(beginAuthorization).not.toHaveBeenCalled();

    expect(response.headers.location).toBeUndefined();

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not write a cookie or redirect when transaction creation fails', async () => {
    const writeSpy = jest.spyOn(stateCookieService, 'write');

    beginAuthorization.mockRejectedValueOnce(new ServiceUnavailableException());

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_START_PATH)
      .redirects(0)
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    expect(writeSpy).not.toHaveBeenCalled();

    expect(response.headers.location).toBeUndefined();

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not redirect when cookie serialization fails', async () => {
    jest.spyOn(stateCookieService, 'write').mockImplementationOnce(() => {
      throw new Error('Cookie serialization failed');
    });

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_START_PATH)
      .redirects(0)
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);

    expect(beginAuthorization).toHaveBeenCalledTimes(1);

    expect(response.headers.location).toBeUndefined();

    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
