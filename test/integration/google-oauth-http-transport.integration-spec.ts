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
import {
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_SESSION_PATH,
} from '../../src/modules/auth/constants/google-oauth-route.constants';
import { GoogleOAuthCallbackController } from '../../src/modules/auth/controllers/google-oauth-callback.controller';
import { GoogleOAuthSessionController } from '../../src/modules/auth/controllers/google-oauth-session.controller';
import { GoogleOAuthAccountResolutionStatus } from '../../src/modules/auth/interfaces/google-oauth-account-resolution.interface';
import {
  GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT,
  GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF,
} from '../../src/modules/auth/interfaces/google-oauth-callback.interface';
import { GoogleOAuthSessionHandoffInvalidException } from '../../src/modules/auth/exceptions/google-oauth-session-handoff-invalid.exception';
import { GoogleOAuthTransactionInvalidException } from '../../src/modules/auth/exceptions/google-oauth-transaction-invalid.exception';
import type { AuthResponse } from '../../src/modules/auth/interfaces/auth.interface';
import { GoogleOAuthContinuationOriginGuard } from '../../src/modules/auth/guards/google-oauth-continuation-origin.guard';
import { AuthRateLimitService } from '../../src/modules/auth/services/auth-rate-limit.service';
import { GoogleOAuthCallbackService } from '../../src/modules/auth/services/google-oauth-callback.service';
import { GoogleOAuthContinuationCookieService } from '../../src/modules/auth/services/google-oauth-continuation-cookie.service';
import { GoogleOAuthFrontendRedirectService } from '../../src/modules/auth/services/google-oauth-frontend-redirect.service';
import { GoogleOAuthSessionHandoffCookieService } from '../../src/modules/auth/services/google-oauth-session-handoff-cookie.service';
import { GoogleOAuthSessionHandoffService } from '../../src/modules/auth/services/google-oauth-session-handoff.service';
import { GoogleOAuthStateCookieService } from '../../src/modules/auth/services/google-oauth-state-cookie.service';

const ORIGIN = 'http://localhost:5173';
const PROVIDER_STATE = 'p'.repeat(43);
const BROWSER_STATE = 'b'.repeat(43);
const CODE = 'provider-authorization-code-secret';
const HANDOFF = 'h'.repeat(43);
const LINK_GRANT = 'l'.repeat(43);
const REGISTRATION_GRANT = 'r'.repeat(43);

const AUTH_RESPONSE: AuthResponse = {
  message: 'Dang nhap bang Google thanh cong',
  access_token: 'access-token-secret',
  refresh_token: 'refresh-token-secret',
  user: {
    id: 'usr_google',
    publicId: 'usr_google',
    username: 'google.user',
    fullname: 'Google User',
    email: 'google@example.com',
    phone: '0912345678',
    avatar: null,
    hasCustomAvatar: false,
    streakCount: 0,
    status: 'active',
    notificationSettings: {
      enabled: true,
      follow: true,
      reaction: true,
      recap: true,
    },
  },
};

const handleCallback = jest.fn<GoogleOAuthCallbackService['handleCallback']>();

const consumeRejectedCallback =
  jest.fn<GoogleOAuthCallbackService['consumeRejectedCallback']>();

const consumeHandoff = jest.fn<GoogleOAuthSessionHandoffService['consume']>();

const consumeGoogleOAuthSession =
  jest.fn<AuthRateLimitService['consumeGoogleOAuthSession']>();

const serializeCookies = (header: string | string[] | undefined): string =>
  Array.isArray(header) ? header.join('\n') : String(header ?? '');

describe('Google OAuth callback/session HTTP transport', () => {
  let app: INestApplication;
  let httpServer: Server;
  let handoffCookieService: GoogleOAuthSessionHandoffCookieService;

  beforeAll(async () => {
    const values: Record<string, string> = {
      NODE_ENV: 'test',
      CORS_ALLOWED_ORIGINS: ORIGIN,
      GOOGLE_OAUTH_FRONTEND_ORIGIN: ORIGIN,
      GOOGLE_OAUTH_CONTINUATION_COOKIE_SAME_SITE: 'lax',
      GOOGLE_OAUTH_SESSION_HANDOFF_COOKIE_SAME_SITE: 'lax',
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [
        GoogleOAuthCallbackController,
        GoogleOAuthSessionController,
      ],
      providers: [
        GoogleOAuthStateCookieService,
        GoogleOAuthContinuationCookieService,
        GoogleOAuthSessionHandoffCookieService,
        GoogleOAuthFrontendRedirectService,
        GoogleOAuthContinuationOriginGuard,
        {
          provide: GoogleOAuthCallbackService,
          useValue: {
            handleCallback,
            consumeRejectedCallback,
          },
        },
        {
          provide: GoogleOAuthSessionHandoffService,
          useValue: {
            consume: consumeHandoff,
          },
        },
        {
          provide: AuthRateLimitService,
          useValue: {
            consumeGoogleOAuthSession,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string): string | undefined => values[key],
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.enableCors({
      origin: [ORIGIN],
      credentials: true,
    });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    httpServer = app.getHttpServer() as Server;
    handoffCookieService = app.get(GoogleOAuthSessionHandoffCookieService);
  });

  beforeEach(() => {
    jest.restoreAllMocks();

    handleCallback.mockReset().mockResolvedValue({
      status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
      [GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF]: {
        rawHandoff: HANDOFF,
        expiresAt: new Date(Date.now() + 120_000),
      },
    });

    consumeRejectedCallback.mockReset().mockResolvedValue();

    consumeHandoff.mockReset().mockResolvedValue(AUTH_RESPONSE);

    consumeGoogleOAuthSession.mockReset().mockResolvedValue();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers both transport controllers', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      AuthModule,
    ) as unknown[];

    expect(controllers).toContain(GoogleOAuthCallbackController);
    expect(controllers).toContain(GoogleOAuthSessionController);
  });

  it('writes the handoff cookie and redirects with no secret', async () => {
    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .set('User-Agent', 'HTTP Integration Browser')
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/session`);
    expect(response.text).toBe('');

    const cookies = serializeCookies(response.headers['set-cookie']);

    expect(cookies).toContain(`betta_google_session_handoff=${HANDOFF}`);
    expect(cookies).toContain('Path=/api/v1/auth/google/session');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('betta_google_oauth_state=;');
    expect(cookies).not.toContain('Domain=');

    expect(response.headers.location).not.toContain(CODE);
    expect(response.headers.location).not.toContain(HANDOFF);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');

    const publicTransport = [
      response.headers.location ?? '',
      response.text,
    ].join('\n');

    for (const secret of [
      CODE,
      PROVIDER_STATE,
      BROWSER_STATE,
      HANDOFF,
      LINK_GRANT,
      REGISTRATION_GRANT,
      AUTH_RESPONSE.access_token,
      AUTH_RESPONSE.refresh_token,
    ]) {
      expect(publicTransport).not.toContain(secret);
    }

    expect(handleCallback).toHaveBeenCalledWith({
      authorizationCode: CODE,
      callbackState: PROVIDER_STATE,
      browserState: BROWSER_STATE,
      metadata: {
        userAgent: 'HTTP Integration Browser',
      },
    });
  });

  it('writes an account-link continuation cookie', async () => {
    handleCallback.mockResolvedValueOnce({
      status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
      email: 'user@example.com',
      [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: {
        rawGrant: LINK_GRANT,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/link`);

    const cookies = serializeCookies(response.headers['set-cookie']);

    expect(cookies).toContain(`betta_google_link_grant=${LINK_GRANT}`);
    expect(cookies).toContain('Path=/api/v1/auth/google/continuation/link');
    expect(response.headers.location).not.toContain(LINK_GRANT);
  });

  it('writes a registration continuation cookie', async () => {
    handleCallback.mockResolvedValueOnce({
      status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
      profile: {
        email: 'new-user@example.com',
        fullname: 'New User',
        avatar: null,
      },
      [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: {
        rawGrant: REGISTRATION_GRANT,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/register`);

    const cookies = serializeCookies(response.headers['set-cookie']);

    expect(cookies).toContain(
      `betta_google_registration_grant=${REGISTRATION_GRANT}`,
    );
    expect(cookies).toContain(
      'Path=/api/v1/auth/google/continuation/registration',
    );
    expect(response.headers.location).not.toContain(REGISTRATION_GRANT);
  });

  it('consumes a provider cancellation and redirects safely', async () => {
    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        error: 'access_denied',
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(consumeRejectedCallback).toHaveBeenCalledWith(
      PROVIDER_STATE,
      BROWSER_STATE,
    );

    expect(handleCallback).not.toHaveBeenCalled();
    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/cancelled`);
    expect(response.headers.location).not.toContain('access_denied');

    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_oauth_state=;',
    );
  });

  it('consumes other provider errors and uses the fixed error route', async () => {
    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        error: 'temporarily_unavailable',
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(consumeRejectedCallback).toHaveBeenCalledWith(
      PROVIDER_STATE,
      BROWSER_STATE,
    );
    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/error`);
    expect(response.headers.location).not.toContain('temporarily_unavailable');
  });

  it('redirects a callback with a missing state cookie to the fixed error route', async () => {
    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(handleCallback).not.toHaveBeenCalled();
    expect(consumeRejectedCallback).not.toHaveBeenCalled();
    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/error`);
    expect(response.text).toBe('');

    const cookies = serializeCookies(response.headers['set-cookie']);

    expect(cookies).toContain('betta_google_oauth_state=;');
    expect(response.headers.location).not.toContain(CODE);
    expect(response.headers.location).not.toContain(PROVIDER_STATE);
  });

  it('redirects a consumed transaction replay without clearing its continuation grant', async () => {
    handleCallback.mockRejectedValueOnce(
      new GoogleOAuthTransactionInvalidException(),
    );

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set(
        'Cookie',
        [
          `betta_google_oauth_state=${BROWSER_STATE}`,
          `betta_google_registration_grant=${REGISTRATION_GRANT}`,
        ].join('; '),
      )
      .redirects(0)
      .expect(HttpStatus.FOUND);

    expect(handleCallback).toHaveBeenCalledTimes(1);
    expect(response.headers.location).toBe(`${ORIGIN}/auth/google/error`);
    expect(response.text).toBe('');

    const cookies = serializeCookies(response.headers['set-cookie']);

    expect(cookies).toContain('betta_google_oauth_state=;');
    expect(cookies).not.toContain('betta_google_registration_grant=;');

    const publicTransport = [
      response.headers.location ?? '',
      response.text,
    ].join('\n');

    for (const secret of [
      CODE,
      PROVIDER_STATE,
      BROWSER_STATE,
      REGISTRATION_GRANT,
    ]) {
      expect(publicTransport).not.toContain(secret);
    }
  });

  it('rejects ambiguous callback query and clears state', async () => {
    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
        error: 'access_denied',
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.BAD_REQUEST);

    expect(handleCallback).not.toHaveBeenCalled();
    expect(consumeRejectedCallback).not.toHaveBeenCalled();
    expect(response.headers.location).toBeUndefined();
    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_oauth_state=;',
    );
  });

  it('clears state and returns 503 when callback core fails', async () => {
    handleCallback.mockRejectedValueOnce(new ServiceUnavailableException());

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    expect(response.headers.location).toBeUndefined();
    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_oauth_state=;',
    );
    expect(JSON.stringify(response.body)).not.toContain(CODE);
  });

  it('does not redirect when handoff cookie serialization fails', async () => {
    jest.spyOn(handoffCookieService, 'write').mockImplementationOnce(() => {
      throw new Error('Cookie serialization failed');
    });

    const response = await request(httpServer)
      .get(GOOGLE_OAUTH_CALLBACK_PATH)
      .query({
        state: PROVIDER_STATE,
        code: CODE,
      })
      .set('Cookie', `betta_google_oauth_state=${BROWSER_STATE}`)
      .redirects(0)
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);

    expect(response.headers.location).toBeUndefined();
    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_oauth_state=;',
    );
    expect(JSON.stringify(response.body)).not.toContain(CODE);
  });

  it('redeems once, returns the public envelope and clears cookie', async () => {
    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.OK);

    const { message, ...expectedSession } = AUTH_RESPONSE;

    expect(response.body).toEqual({
      success: true,
      message,
      data: expectedSession,
    });
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');

    expect(consumeGoogleOAuthSession).toHaveBeenCalledTimes(1);
    expect(consumeHandoff).toHaveBeenCalledWith(HANDOFF);

    expect(consumeGoogleOAuthSession.mock.invocationCallOrder[0]).toBeLessThan(
      consumeHandoff.mock.invocationCallOrder[0],
    );

    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_session_handoff=;',
    );
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('rejects missing Origin before rate limit or consume', async () => {
    await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.FORBIDDEN);

    expect(consumeGoogleOAuthSession).not.toHaveBeenCalled();
    expect(consumeHandoff).not.toHaveBeenCalled();
  });

  it('rejects an unknown Origin before rate limit or consume', async () => {
    await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', 'https://attacker.example')
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.FORBIDDEN);

    expect(consumeGoogleOAuthSession).not.toHaveBeenCalled();
    expect(consumeHandoff).not.toHaveBeenCalled();
  });

  it('clears a missing or malformed handoff cookie', async () => {
    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .expect(HttpStatus.UNAUTHORIZED);

    expect(consumeHandoff).not.toHaveBeenCalled();
    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_session_handoff=;',
    );
  });

  it('clears a definitively invalid handoff cookie', async () => {
    consumeHandoff.mockRejectedValueOnce(
      new GoogleOAuthSessionHandoffInvalidException(),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.UNAUTHORIZED);

    expect(serializeCookies(response.headers['set-cookie'])).toContain(
      'betta_google_session_handoff=;',
    );
  });

  it('preserves handoff cookie for rate limit and 503', async () => {
    consumeGoogleOAuthSession.mockRejectedValueOnce(
      new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS),
    );

    const limited = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.TOO_MANY_REQUESTS);

    expect(limited.headers['set-cookie']).toBeUndefined();

    consumeHandoff.mockRejectedValueOnce(new ServiceUnavailableException());

    const unavailable = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    expect(unavailable.headers['set-cookie']).toBeUndefined();
  });

  it('preserves the handoff cookie for an unknown failure', async () => {
    consumeHandoff.mockRejectedValueOnce(
      new Error('Unexpected infrastructure error'),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_SESSION_PATH)
      .set('Origin', ORIGIN)
      .set('Cookie', `betta_google_session_handoff=${HANDOFF}`)
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);

    expect(response.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(HANDOFF);
  });
});
