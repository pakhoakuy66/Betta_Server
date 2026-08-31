import {
  HttpStatus,
  type INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
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
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { ApiResponseInterceptor } from '../../src/common/interceptors/api-response.interceptor';
import { ReportsController } from '../../src/modules/reports/controllers/reports.controller';
import { AccessSupportChallengeRequiredException } from '../../src/modules/reports/exceptions/access-support-challenge-required.exception';
import { AccessSupportBodyLimitGuard } from '../../src/modules/reports/guards/access-support-body-limit.guard';
import { ReportIssueUploadRateLimitGuard } from '../../src/modules/reports/guards/report-issue-upload-rate-limit.guard';
import { installAccessSupportAttemptMiddleware } from '../../src/modules/reports/middleware/access-support-attempt.middleware';
import { AccessSupportRateLimitService } from '../../src/modules/reports/services/access-support-rate-limit.service';
import { AccessSupportService } from '../../src/modules/reports/services/access-support.service';
import { ReportRateLimitService } from '../../src/modules/reports/services/report-rate-limit.service';
import { ReportsService } from '../../src/modules/reports/services/reports.service';

const REPORT_PUBLIC_ID = 'srep_23456789ABCDEFGH';
const ACKNOWLEDGEMENT =
  'Yêu cầu hỗ trợ đã được ghi nhận. Chúng tôi sẽ xem xét thông tin bạn cung cấp.';

const validPayload = {
  category: 'LOGIN_PROBLEM',
  contactEmail: 'person@example.com',
  description: 'Tôi không thể đăng nhập vào tài khoản từ sáng nay.',
  accountEmailOrUsername: 'person',
  correlationId: 'corr-adm-mod-07-0001',
};

type ApiEnvelope<T> = Readonly<{ success: true; data: T }>;
type ErrorEnvelope = Readonly<{
  success: false;
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
}>;

type RawHttpResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}>;

describe('Public access-support HTTP contract integration', () => {
  let app: INestApplication<App>;
  const submit = jest.fn<AccessSupportService['submit']>();
  const consumeIp = jest
    .fn<AccessSupportRateLimitService['consumeIp']>()
    .mockResolvedValue(undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        AccessSupportBodyLimitGuard,
        {
          provide: ReportIssueUploadRateLimitGuard,
          useValue: { canActivate: () => true },
        },
        {
          provide: ReportRateLimitService,
          useValue: { consumeSystemUpload: () => Promise.resolve() },
        },
        {
          provide: AccessSupportRateLimitService,
          useValue: { consumeIp },
        },
        { provide: ReportsService, useValue: {} },
        { provide: AccessSupportService, useValue: { submit } },
        { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    installAccessSupportAttemptMiddleware(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    consumeIp.mockResolvedValue(undefined);
    submit.mockResolvedValue({
      reportPublicId: REPORT_PUBLIC_ID,
      message: ACKNOWLEDGEMENT,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('accepts a public JSON request without JWT and returns only the opaque receipt', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .send(validPayload)
      .expect(HttpStatus.CREATED);

    expect(response.body as ApiEnvelope<unknown>).toEqual({
      success: true,
      data: {
        reportPublicId: REPORT_PUBLIC_ID,
        message: ACKNOWLEDGEMENT,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('person@example.com');
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'LOGIN_PROBLEM',
        contactEmail: 'person@example.com',
      }),
      expect.any(String),
      undefined,
      true,
    );
    expect(consumeIp).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown fields and keeps validation errors private', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .send({ ...validPayload, role: 'SUPER_ADMIN' })
      .expect(HttpStatus.BAD_REQUEST);

    const body = response.body as ErrorEnvelope;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.path).toBe('/api/v1/reports/access-issues');
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(consumeIp).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects multipart/file intake before the controller is called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .field('category', 'LOGIN_PROBLEM')
      .field('contactEmail', 'person@example.com')
      .field('description', validPayload.description)
      .attach('evidence', Buffer.from('not-an-image'), 'evidence.txt')
      .expect(HttpStatus.UNSUPPORTED_MEDIA_TYPE);

    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(consumeIp).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects an oversized JSON body before persistence', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .send({ ...validPayload, description: 'x'.repeat(13 * 1024) })
      .expect(HttpStatus.PAYLOAD_TOO_LARGE);

    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(consumeIp).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('counts malformed JSON before parser validation rejects it', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .set('Content-Type', 'application/json')
      .send('{"category":')
      .expect(HttpStatus.BAD_REQUEST);

    expect(consumeIp).toHaveBeenCalledTimes(1);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(submit).not.toHaveBeenCalled();
  });

  it('can require challenge before malformed JSON reaches the parser', async () => {
    consumeIp.mockRejectedValueOnce(
      new AccessSupportChallengeRequiredException({
        token: 'challenge-token-23456789ABCDEFGH',
        difficultyBits: 16,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .set('Content-Type', 'application/json')
      .send('{"category":')
      .expect(428);

    expect((response.body as ErrorEnvelope).error).toBe(
      'ACCESS_SUPPORT_CHALLENGE_REQUIRED',
    );
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects chunked raw JSON over 12 KiB even when parsed data is small', async () => {
    const rawJson = `{${' '.repeat(13 * 1024)}"category":"LOGIN_PROBLEM","contactEmail":"person@example.com","description":"Tôi không thể đăng nhập vào tài khoản từ sáng nay."}`;
    const response = await sendChunkedJson(app, rawJson);

    expect(response.statusCode).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(consumeIp).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails closed with a generic 503 when durable storage is unavailable', async () => {
    submit.mockRejectedValueOnce(
      new ServiceUnavailableException('internal storage topology'),
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/reports/access-issues')
      .send(validPayload)
      .expect(HttpStatus.SERVICE_UNAVAILABLE);

    const body = response.body as ErrorEnvelope;
    expect(body.message).toBe('Dịch vụ tạm thời không khả dụng');
    expect(JSON.stringify(body)).not.toContain('internal storage topology');
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
  });

  it('does not expose a public report lookup route', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/reports/access-issues/${REPORT_PUBLIC_ID}`)
      .expect(HttpStatus.NOT_FOUND);
  });
});

const sendChunkedJson = (
  app: INestApplication<App>,
  rawJson: string,
): Promise<RawHttpResponse> => {
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/v1/reports/access-issues',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );

    request.on('error', reject);
    const midpoint = Math.floor(rawJson.length / 2);
    request.write(rawJson.slice(0, midpoint));
    request.write(rawJson.slice(midpoint));
    request.end();
  });
};
