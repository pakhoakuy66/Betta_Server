import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  INestApplication,
  ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { SponsoredLifecycleController } from './sponsored-lifecycle.controller';
import { SponsoredLifecycleService } from './sponsored-lifecycle.service';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { AdminRole } from '../admin/constants/admin-account.constants';

describe('SADM-SPON-03 HTTP, stub JWT with real permissions and validation', () => {
  let app: INestApplication;
  const execute = jest
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ version: 1 });
  const body = { expectedVersion: 0, reasonCode: 'campaign_review' };
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SponsoredLifecycleController],
      providers: [
        AdminPermissionGuard,
        { provide: SponsoredLifecycleService, useValue: { execute } },
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
    app = moduleRef.createNestApplication();
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
  for (const action of [
    'schedule',
    'activate',
    'pause',
    'resume',
    'return-to-draft',
  ]) {
    const url = `/api/v1/admin/sponsored-posts/spn_23456789ABCDEFGH/${action}`;
    it(`${action}: rejects anonymous/User/Admin and permits SuperAdmin only`, async () => {
      execute.mockClear();
      await request(app.getHttpServer() as Server)
        .post(url)
        .send(body)
        .expect(401);
      await request(app.getHttpServer() as Server)
        .post(url)
        .set('Authorization', 'Bearer user')
        .send(body)
        .expect(401);
      await request(app.getHttpServer() as Server)
        .post(url)
        .set('Authorization', 'Bearer admin')
        .send(body)
        .expect(403);
      expect(execute).not.toHaveBeenCalled();
      const response = await request(app.getHttpServer() as Server)
        .post(url)
        .set('Authorization', 'Bearer super')
        .send(body)
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store, max-age=0');
      expect(execute).toHaveBeenCalledTimes(1);
    });
    it(`${action}: rejects client-controlled state, string version, and missing reason`, async () => {
      execute.mockClear();
      for (const invalid of [
        { ...body, status: 'active' },
        { ...body, expectedVersion: '0' },
        { expectedVersion: 0 },
      ])
        await request(app.getHttpServer() as Server)
          .post(url)
          .set('Authorization', 'Bearer super')
          .send(invalid)
          .expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  }
});
