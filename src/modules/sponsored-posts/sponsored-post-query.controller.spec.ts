import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  type INestApplication,
  type ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type Server } from 'node:http';
import { SponsoredPostQueryController } from './sponsored-post-query.controller';
import { SponsoredPostQueryService } from './sponsored-post-query.service';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { AdminRole } from '../admin/constants/admin-account.constants';

describe('SADM-SPON-07 HTTP contract (authentication boundary stub, real permission guard)', () => {
  let app: INestApplication;
  let log: { mockRestore(): void };
  const reader = {
    list: jest.fn<() => Promise<unknown>>(),
    detail: jest.fn<() => Promise<unknown>>(),
  };
  const publicId = 'spn_23456789ABCDEFGH';
  beforeAll(async () => {
    reader.list.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 20, hasMore: false },
    });
    reader.detail.mockResolvedValue({ publicId, status: 'deleted' });
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      controllers: [SponsoredPostQueryController],
      providers: [
        AdminPermissionGuard,
        { provide: SponsoredPostQueryService, useValue: reader },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const token = req.headers.authorization;
          if (
            token !== 'Bearer fixture-admin' &&
            token !== 'Bearer fixture-super'
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
              token === 'Bearer fixture-super'
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
    log?.mockRestore();
  });
  it.each(['', '/spn_23456789ABCDEFGH'])(
    'denies unauthenticated/User/Admin at route %s',
    async (suffix) => {
      const url = `/api/v1/admin/sponsored-posts${suffix}`;
      const before =
        reader.list.mock.calls.length + reader.detail.mock.calls.length;
      await request(app.getHttpServer() as Server)
        .get(url)
        .expect(401);
      await request(app.getHttpServer() as Server)
        .get(url)
        .set('Authorization', 'Bearer fixture-user')
        .expect(401);
      await request(app.getHttpServer() as Server)
        .get(url)
        .set('Authorization', 'Bearer fixture-admin')
        .expect(403);
      expect(
        reader.list.mock.calls.length + reader.detail.mock.calls.length,
      ).toBe(before);
    },
  );
  it('returns empty list and deleted detail with no-store headers', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/admin/sponsored-posts')
      .set('Authorization', 'Bearer fixture-super')
      .expect(200);
    expect(response.body).toEqual({
      success: true,
      data: { items: [], pagination: { page: 1, limit: 20, hasMore: false } },
    });
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const detail = await request(app.getHttpServer() as Server)
      .get(`/api/v1/admin/sponsored-posts/${publicId}`)
      .set('Authorization', 'Bearer fixture-super')
      .expect(200);
    expect(detail.body).toEqual({
      success: true,
      data: { publicId, status: 'deleted' },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('SPONSORED_DETAIL_ACCESSED'),
    );
  });
  it('rejects injected query and invalid publicId before reader', async () => {
    const before =
      reader.list.mock.calls.length + reader.detail.mock.calls.length;
    await request(app.getHttpServer() as Server)
      .get('/api/v1/admin/sponsored-posts?status[$ne]=deleted')
      .set('Authorization', 'Bearer fixture-super')
      .expect(400);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/admin/sponsored-posts/not-an-id')
      .set('Authorization', 'Bearer fixture-super')
      .expect(400);
    expect(
      reader.list.mock.calls.length + reader.detail.mock.calls.length,
    ).toBe(before);
  });
});
