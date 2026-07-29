import {
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  type INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
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
import { AuthGuard } from '@nestjs/passport';
import type { Request as ExpressRequest } from 'express';
import type { Server } from 'node:http';
import { Types } from 'mongoose';
import request from 'supertest';

import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import type {
  AuthenticatedRequest,
  JwtRequestUser,
} from '../../src/common/types/authenticated-request';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { GOOGLE_OAUTH_UNLINK_PATH } from '../../src/modules/auth/constants/google-oauth-route.constants';
import { PASSWORD_MAX_LENGTH } from '../../src/modules/auth/constants/password-policy';
import { GoogleOAuthAccountController } from '../../src/modules/auth/controllers/google-oauth-account.controller';
import { AuthRateLimitService } from '../../src/modules/auth/services/auth-rate-limit.service';
import { GoogleOAuthAccountUnlinkService } from '../../src/modules/auth/services/google-oauth-account-unlink.service';

const USER_ID = new Types.ObjectId('6a661963b935314f1141a514');
const ACCESS_TOKEN = 'valid-test-access-token';
const CURRENT_PASSWORD = 'CurrentPassword123.';

const JWT_USER: JwtRequestUser = {
  _id: USER_ID.toString(),
  id: USER_ID.toString(),
  email: 'user@example.com',
  username: 'user',
  sessionId: 'ses_12345678901234567890',
};

const consumeGoogleOAuthUnlink =
  jest.fn<AuthRateLimitService['consumeGoogleOAuthUnlink']>();

const unlinkGoogleAccount =
  jest.fn<GoogleOAuthAccountUnlinkService['unlinkGoogleAccount']>();

const jwtGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<ExpressRequest & Partial<AuthenticatedRequest>>();

    if (request.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) {
      throw new UnauthorizedException();
    }

    request.user = JWT_USER;

    return true;
  },
};

describe('Google OAuth account-unlink HTTP transport', () => {
  let app: INestApplication;
  let httpServer: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GoogleOAuthAccountController],
      providers: [
        {
          provide: AuthRateLimitService,
          useValue: {
            consumeGoogleOAuthUnlink,
          },
        },
        {
          provide: GoogleOAuthAccountUnlinkService,
          useValue: {
            unlinkGoogleAccount,
          },
        },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue(jwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());

    await app.init();

    httpServer = app.getHttpServer() as Server;
  });

  beforeEach(() => {
    consumeGoogleOAuthUnlink.mockReset().mockResolvedValue();
    unlinkGoogleAccount.mockReset().mockResolvedValue();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is registered in AuthModule', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      AuthModule,
    ) as unknown[];

    expect(controllers).toContain(GoogleOAuthAccountController);
  });

  it('requires an access token', async () => {
    await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .send({
        currentPassword: CURRENT_PASSWORD,
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(consumeGoogleOAuthUnlink).not.toHaveBeenCalled();
    expect(unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing password',
      body: {},
    },
    {
      name: 'non-string password',
      body: {
        currentPassword: 123456,
      },
    },
    {
      name: 'oversized password',
      body: {
        currentPassword: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
      },
    },
    {
      name: 'unknown field',
      body: {
        currentPassword: CURRENT_PASSWORD,
        providerAccountId: 'must-not-be-accepted',
      },
    },
  ])('rejects invalid DTO: $name', async ({ body }) => {
    await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send(body)
      .expect(HttpStatus.BAD_REQUEST);

    expect(consumeGoogleOAuthUnlink).not.toHaveBeenCalled();
    expect(unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it('rate limits then unlinks and returns no secret', async () => {
    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
      })
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({
      success: true,
      data: null,
      message: 'Đã hủy liên kết tài khoản Google',
    });

    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    expect(consumeGoogleOAuthUnlink).toHaveBeenCalledWith(
      expect.any(String),
      USER_ID.toString(),
    );

    expect(unlinkGoogleAccount).toHaveBeenCalledTimes(1);

    const [calledUserId, calledPassword] = unlinkGoogleAccount.mock.calls[0];

    expect(calledUserId).toBeInstanceOf(Types.ObjectId);
    expect(calledUserId.toString()).toBe(USER_ID.toString());
    expect(calledPassword).toBe(CURRENT_PASSWORD);

    expect(consumeGoogleOAuthUnlink.mock.invocationCallOrder[0]).toBeLessThan(
      unlinkGoogleAccount.mock.invocationCallOrder[0],
    );

    const publicResponse = JSON.stringify(response.body);

    expect(publicResponse).not.toContain(USER_ID.toString());
    expect(publicResponse).not.toContain(CURRENT_PASSWORD);
    expect(publicResponse).not.toContain('providerAccountId');
  });

  it('passes the current password without trimming or normalization', async () => {
    const exactPassword = '  CurrentPassword123.  ';

    await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: exactPassword,
      })
      .expect(HttpStatus.OK);

    expect(unlinkGoogleAccount).toHaveBeenCalledWith(
      expect.any(Types.ObjectId),
      exactPassword,
    );
  });

  it('stops before unlink when rate limited', async () => {
    consumeGoogleOAuthUnlink.mockRejectedValueOnce(
      new HttpException(
        {
          message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
          retryAfterSeconds: 60,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
      })
      .expect(HttpStatus.TOO_MANY_REQUESTS);

    expect(response.headers['retry-after']).toBe('60');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it('preserves invalid-password unauthorized response', async () => {
    unlinkGoogleAccount.mockRejectedValueOnce(
      new UnauthorizedException('Mật khẩu không chính xác'),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: 'IncorrectPassword123.',
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toMatchObject({
      success: false,
      statusCode: HttpStatus.UNAUTHORIZED,
      error: 'UNAUTHORIZED',
      message: 'Mật khẩu không chính xác',
      path: GOOGLE_OAUTH_UNLINK_PATH,
    });
  });

  it('preserves last-login-method conflict', async () => {
    unlinkGoogleAccount.mockRejectedValueOnce(
      new ConflictException(
        'Hãy thiết lập mật khẩu trước khi hủy liên kết Google',
      ),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
      })
      .expect(HttpStatus.CONFLICT);

    expect(response.body).toMatchObject({
      success: false,
      statusCode: HttpStatus.CONFLICT,
      error: 'CONFLICT',
      path: GOOGLE_OAUTH_UNLINK_PATH,
    });
  });

  it('returns a sanitized 503 infrastructure response', async () => {
    unlinkGoogleAccount.mockRejectedValueOnce(
      new ServiceUnavailableException('Sensitive infrastructure details'),
    );

    const response = await request(httpServer)
      .post(GOOGLE_OAUTH_UNLINK_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
      })
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    expect(response.body).toMatchObject({
      success: false,
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Dịch vụ tạm thời không khả dụng',
      path: GOOGLE_OAUTH_UNLINK_PATH,
    });

    expect(JSON.stringify(response.body)).not.toContain(
      'Sensitive infrastructure details',
    );
  });
});
