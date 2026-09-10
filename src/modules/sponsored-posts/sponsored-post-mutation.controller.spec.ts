import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  type INestApplication,
  type ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { SponsoredPostMutationController } from './sponsored-post-mutation.controller';
import { SponsoredPostMutationService } from './sponsored-post-mutation.service';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { AdminRole } from '../admin/constants/admin-account.constants';

describe('SADM-SPON-08 HTTP (stub authentication, real permission/validation)', () => {
  let app: INestApplication;
  const execute = jest
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ publicId: 'spn_23456789ABCDEFGH' });
  const payload = {
    content: 'Synthetic',
    cta: 'Read more',
    destinationUrl: 'https://example.com',
    startAt: '2026-09-10T00:00:00Z',
    endAt: '2026-09-12T00:00:00Z',
    reasonCode: 'campaign_review',
  };
  const routes = [
    { method: 'post' as const, suffix: '', body: payload, status: 201 },
    {
      method: 'patch' as const,
      suffix: '/spn_23456789ABCDEFGH',
      body: { ...payload, expectedVersion: 0 },
      status: 200,
    },
    {
      method: 'post' as const,
      suffix: '/spn_23456789ABCDEFGH/delete',
      body: { expectedVersion: 0, reasonCode: 'campaign_review' },
      status: 200,
    },
    {
      method: 'post' as const,
      suffix: '/spn_23456789ABCDEFGH/restore',
      body: { expectedVersion: 1, reasonCode: 'campaign_review' },
      status: 200,
    },
  ];
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SponsoredPostMutationController],
      providers: [
        AdminPermissionGuard,
        { provide: SponsoredPostMutationService, useValue: { execute } },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          if (
            !['Bearer admin', 'Bearer super'].includes(
              req.headers.authorization,
            )
          )
            throw new UnauthorizedException();
          req.user = {
            adminAccountId: '012345678901234567890123',
            id: 'adm_23456789ABCD',
            publicId: 'adm_23456789ABCD',
            username: 'fixture',
            displayName: 'Fixture',
            sessionId: 'ases_23456789ABCDEFGH',
            role:
              req.headers.authorization === 'Bearer super'
                ? AdminRole.SUPER_ADMIN
                : AdminRole.ADMIN,
            credentialVersion: 0,
            authzVersion: 0,
            permissionVersion: 1,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  it.each(routes)(
    'enforces permissions and body on $method $suffix',
    async ({ method, suffix, body, status }) => {
      const send = () =>
        request(app.getHttpServer() as Server)[method](
          '/api/v1/admin/sponsored-posts' + suffix,
        );
      const before = execute.mock.calls.length;
      await send().send(body).expect(401);
      await send().set('Authorization', 'Bearer user').send(body).expect(401);
      await send().set('Authorization', 'Bearer admin').send(body).expect(403);
      await send()
        .set('Authorization', 'Bearer super')
        .send({ ...body, ownerPublicId: 'forged' })
        .expect(400);
      expect(execute.mock.calls.length).toBe(before);
      const result = await send()
        .set('Authorization', 'Bearer super')
        .set('Idempotency-Key', 'manual-case-00000001')
        .send({ ...body, correlationId: '  corr_spon_http_0001  ' })
        .expect(status);
      expect(execute).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(String),
        suffix ? expect.any(String) : null,
        expect.objectContaining({ correlationId: 'corr_spon_http_0001' }),
        'manual-case-00000001',
      );
      expect(result.headers['cache-control']).toBe('no-store, max-age=0');
      expect(execute.mock.calls.length).toBe(before + 1);
    },
  );
});
