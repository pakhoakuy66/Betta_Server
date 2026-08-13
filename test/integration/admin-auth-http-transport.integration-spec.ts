import {
  type ExecutionContext,
  HttpStatus,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
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
import request, { type Response as SupertestResponse } from 'supertest';
import type { App } from 'supertest/types';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { ApiResponseInterceptor } from '../../src/common/interceptors/api-response.interceptor';
import {
  ADMIN_POLICY,
  type AdminPolicy,
} from '../../src/modules/admin/config/admin-policy.config';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import {
  ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
} from '../../src/modules/admin/constants/admin-auth-transport.constants';
import { AdminAuthController } from '../../src/modules/admin/controllers/admin-auth.controller';
import { AdminAuthOriginGuard } from '../../src/modules/admin/guards/admin-auth-origin.guard';
import { AdminCsrfGuard } from '../../src/modules/admin/guards/admin-csrf.guard';
import { AdminJwtAuthGuard } from '../../src/modules/admin/guards/admin-jwt-auth.guard';
import { type AdminAuthenticationResult } from '../../src/modules/admin/interfaces/admin-auth.interface';
import { AdminAuthCookieService } from '../../src/modules/admin/services/admin-auth-cookie.service';
import { AdminAuthService } from '../../src/modules/admin/services/admin-auth.service';
import { AdminSessionService } from '../../src/modules/admin/services/admin-session.service';

const ALLOWED_ORIGIN = 'https://admin.betta.test';
const HOSTILE_ORIGIN = 'https://evil.example';
const REFRESH_ONE = 'refresh-credential-one';
const REFRESH_TWO = 'refresh-credential-two';

const principal = {
  adminAccountId: '6a3924c4f5a540da96575f6a',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'root.admin',
  displayName: 'Root Admin',
  role: AdminRole.SUPER_ADMIN,
  sessionId: 'ases_23456789ABCDEFGH',
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
} as const;

const result = (
  refreshToken: string,
  accessToken: string,
): AdminAuthenticationResult => ({
  accessToken,
  refreshToken,
  refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
  sessionPublicId: principal.sessionId,
  admin: {
    id: principal.publicId,
    publicId: principal.publicId,
    username: principal.username,
    displayName: principal.displayName,
    role: principal.role,
  },
});

const setCookies = (response: SupertestResponse): string[] => {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value : value ? [String(value)] : [];
};

const cookiePair = (cookies: readonly string[], name: string): string => {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing cookie ${name}`);
  return cookie.split(';', 1)[0];
};

const cookieValue = (pair: string): string => pair.slice(pair.indexOf('=') + 1);

type ApiEnvelope<T> = Readonly<{ success: true; data: T }>;

const responseBody = <T>(response: SupertestResponse): ApiEnvelope<T> =>
  response.body as unknown as ApiEnvelope<T>;

describe('Admin auth HTTP transport integration', () => {
  let app: INestApplication<App>;
  const auth = {
    login: jest.fn<AdminAuthService['login']>(),
    refresh: jest.fn<AdminAuthService['refresh']>(),
    logout: jest.fn<AdminAuthService['logout']>(),
  };
  const sessions = {
    listActiveSessions: jest.fn<AdminSessionService['listActiveSessions']>(),
    revokeOtherSession: jest.fn<AdminSessionService['revokeOtherSession']>(),
    logoutAllSelf: jest.fn<AdminSessionService['logoutAllSelf']>(),
  };

  beforeAll(async () => {
    const config = {
      get: (key: string): string | undefined => {
        if (key === 'NODE_ENV') return 'production';
        if (key === 'CORS_ALLOWED_ORIGINS') return ALLOWED_ORIGIN;
        if (key === 'ADMIN_AUTH_COOKIE_SAME_SITE') return 'strict';
        return undefined;
      },
    } as ConfigService;
    const policy = {
      session: {
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 604_800,
      },
    } as AdminPolicy;

    const moduleBuilder = Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: auth },
        { provide: AdminSessionService, useValue: sessions },
        { provide: ConfigService, useValue: config },
        { provide: ADMIN_POLICY, useValue: policy },
        AdminAuthCookieService,
        AdminAuthOriginGuard,
        AdminCsrfGuard,
        AdminJwtAuthGuard,
        { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).overrideGuard(AdminJwtAuthGuard);

    const moduleRef = await moduleBuilder
      .useValue({
        canActivate: (context: ExecutionContext): true => {
          const httpRequest = context
            .switchToHttp()
            .getRequest<{ user?: typeof principal }>();
          httpRequest.user = principal;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.enableCors({ origin: [ALLOWED_ORIGIN], credentials: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    auth.login.mockResolvedValue(result(REFRESH_ONE, 'access-one'));
    auth.refresh.mockResolvedValue(result(REFRESH_TWO, 'access-two'));
    auth.logout.mockResolvedValue(true);
    sessions.listActiveSessions.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 20, hasMore: false },
    });
    sessions.revokeOtherSession.mockResolvedValue();
    sessions.logoutAllSelf.mockResolvedValue(2);
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (): Promise<SupertestResponse> =>
    request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({
        email: 'root@betta.test',
        password: 'correct password',
        totpToken: '123456',
      })
      .expect(HttpStatus.OK);

  it('keeps access in the response and refresh only in a hardened cookie', async () => {
    const response = await login();
    const cookies = setCookies(response);
    const refreshCookie = cookies.find((value) =>
      value.startsWith(`${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=`),
    );
    const csrfCookie = cookies.find((value) =>
      value.startsWith(`${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=`),
    );

    expect(response.headers['access-control-allow-origin']).toBe(
      ALLOWED_ORIGIN,
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(refreshCookie).toContain('; Path=/;');
    expect(refreshCookie).toContain('; HttpOnly; Secure;');
    expect(refreshCookie).toContain('; SameSite=Strict');
    expect(csrfCookie).toContain('; Path=/;');
    expect(csrfCookie).toContain('; Secure;');
    expect(csrfCookie).toContain('; HttpOnly;');
    const body = responseBody<{
      accessToken: string;
      csrfToken: string;
      accessTokenExpiresInSeconds: number;
    }>(response);
    expect(body.data.accessToken).toBe('access-one');
    expect(body.data.csrfToken).toBe(
      cookieValue(cookiePair(cookies, ADMIN_CSRF_COOKIE_PRODUCTION_NAME)),
    );
    expect(body.data.accessTokenExpiresInSeconds).toBe(900);
    expect(JSON.stringify(response.body)).not.toContain(REFRESH_ONE);
    expect(body.data).not.toHaveProperty('refreshToken');
  });

  it('rejects missing and hostile origins before authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({
        email: 'root@betta.test',
        password: 'correct password',
        totpToken: '123456',
      })
      .expect(403);

    const hostile = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .set('Origin', HOSTILE_ORIGIN)
      .send({
        email: 'root@betta.test',
        password: 'correct password',
        totpToken: '123456',
      })
      .expect(403);

    expect(hostile.headers['access-control-allow-origin']).toBeUndefined();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('rejects refresh without the double-submit CSRF header', async () => {
    const loginResponse = await login();
    const cookies = setCookies(loginResponse);
    const refreshPair = cookiePair(
      cookies,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const csrfPair = cookiePair(cookies, ADMIN_CSRF_COOKIE_PRODUCTION_NAME);

    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .expect(403);

    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('bootstraps CSRF after reload without JavaScript reading API cookies', async () => {
    const loginResponse = await login();
    const loginCookies = setCookies(loginResponse);
    const refreshPair = cookiePair(
      loginCookies,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const csrfPair = cookiePair(
      loginCookies,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
    );
    const loginCsrf = responseBody<{ csrfToken: string }>(loginResponse).data
      .csrfToken;

    const bootstrapResponse = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/csrf')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .expect(200);
    const bootstrapCsrf = responseBody<{ csrfToken: string }>(bootstrapResponse)
      .data.csrfToken;

    expect(bootstrapCsrf).toBe(loginCsrf);
    expect(bootstrapResponse.headers['cache-control']).toBe(
      'no-store, max-age=0',
    );

    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/csrf')
      .set('Origin', HOSTILE_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .set(ADMIN_CSRF_HEADER_NAME, bootstrapCsrf)
      .expect(200);
  });

  it('rotates both credentials and never serializes the refresh credential', async () => {
    const loginResponse = await login();
    const loginCookies = setCookies(loginResponse);
    const refreshPair = cookiePair(
      loginCookies,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const csrfPair = cookiePair(
      loginCookies,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
    );
    const oldCsrfToken = responseBody<{ csrfToken: string }>(loginResponse).data
      .csrfToken;

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .set(ADMIN_CSRF_HEADER_NAME, oldCsrfToken)
      .expect(200);

    expect(auth.refresh).toHaveBeenCalledWith(REFRESH_ONE);
    expect(
      cookiePair(setCookies(response), ADMIN_REFRESH_COOKIE_PRODUCTION_NAME),
    ).toBe(`${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=${REFRESH_TWO}`);
    const refreshBody = responseBody<{
      accessToken: string;
      csrfToken: string;
    }>(response);
    expect(refreshBody.data.accessToken).toBe('access-two');
    expect(refreshBody.data.csrfToken).not.toBe(oldCsrfToken);
    expect(refreshBody.data.csrfToken).toBe(
      cookieValue(
        cookiePair(setCookies(response), ADMIN_CSRF_COOKIE_PRODUCTION_NAME),
      ),
    );
    expect(JSON.stringify(response.body)).not.toContain(REFRESH_TWO);

    const rotatedRefreshPair = cookiePair(
      setCookies(response),
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const rotatedCsrfPair = cookiePair(
      setCookies(response),
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
    );
    await request(app.getHttpServer())
      .post('/api/v1/admin/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${rotatedRefreshPair}; ${rotatedCsrfPair}`)
      .set(ADMIN_CSRF_HEADER_NAME, oldCsrfToken)
      .expect(403);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('clears both cookies after refresh replay or invalid credential denial', async () => {
    const loginResponse = await login();
    const loginCookies = setCookies(loginResponse);
    const refreshPair = cookiePair(
      loginCookies,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const csrfPair = cookiePair(
      loginCookies,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
    );
    const csrfToken = responseBody<{ csrfToken: string }>(loginResponse).data
      .csrfToken;
    auth.refresh.mockRejectedValueOnce(
      new UnauthorizedException('Phien quan tri khong hop le'),
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .set(ADMIN_CSRF_HEADER_NAME, csrfToken)
      .expect(401);

    const cleared = setCookies(response);
    expect(
      cleared.some((value) =>
        value.startsWith(`${ADMIN_REFRESH_COOKIE_PRODUCTION_NAME}=;`),
      ),
    ).toBe(true);
    expect(
      cleared.some((value) =>
        value.startsWith(`${ADMIN_CSRF_COOKIE_PRODUCTION_NAME}=;`),
      ),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(REFRESH_ONE);
  });

  it('maps the authenticated principal without internal database fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Authorization', 'Bearer access-token')
      .expect(200);

    const body = responseBody<Record<string, unknown>>(response);
    expect(body.data).toEqual({
      id: principal.publicId,
      publicId: principal.publicId,
      username: principal.username,
      displayName: principal.displayName,
      role: principal.role,
      sessionId: principal.sessionId,
    });
    expect(body.data).not.toHaveProperty('adminAccountId');
    expect(body.data).not.toHaveProperty('credentialVersion');
  });

  it('uses the existing session service and clears cookies on logout', async () => {
    const loginResponse = await login();
    const loginCookies = setCookies(loginResponse);
    const refreshPair = cookiePair(
      loginCookies,
      ADMIN_REFRESH_COOKIE_PRODUCTION_NAME,
    );
    const csrfPair = cookiePair(
      loginCookies,
      ADMIN_CSRF_COOKIE_PRODUCTION_NAME,
    );
    const csrfToken = responseBody<{ csrfToken: string }>(loginResponse).data
      .csrfToken;

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Authorization', 'Bearer access-token')
      .set('Cookie', `${refreshPair}; ${csrfPair}`)
      .set(ADMIN_CSRF_HEADER_NAME, csrfToken)
      .expect(200);

    expect(auth.logout).toHaveBeenCalledWith(
      expect.objectContaining({
        publicId: principal.publicId,
        credentialVersion: principal.credentialVersion,
      }),
      principal.sessionId,
    );
    expect(responseBody<{ revoked: boolean }>(response).data).toEqual({
      revoked: true,
    });
    expect(setCookies(response)).toHaveLength(2);
  });
});
