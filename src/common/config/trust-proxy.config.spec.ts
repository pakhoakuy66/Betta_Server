import { Controller, Get, type INestApplication, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  applyTrustProxyConfiguration,
  readTrustProxyHops,
  type TrustProxyApplication,
} from './trust-proxy.config';

@Controller('ip-probe')
class IpProbeController {
  @Get()
  getIp(@Req() httpRequest: Request): { ip: string | undefined } {
    return {
      ip: httpRequest.ip,
    };
  }
}

const createConfig = (value: string | number): ConfigService =>
  ({
    get: (key: string): unknown =>
      key === 'TRUST_PROXY_HOPS' ? value : undefined,
  }) as unknown as ConfigService;

const createApplication = async (hops: number): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({
    controllers: [IpProbeController],
  }).compile();

  const app = moduleRef.createNestApplication();

  const expressApplication = app
    .getHttpAdapter()
    .getInstance() as unknown as TrustProxyApplication;

  applyTrustProxyConfiguration(expressApplication, createConfig(hops));

  await app.init();

  return app;
};

describe('trust proxy configuration', () => {
  it('ignores forged X-Forwarded-For when proxy trust is disabled', async () => {
    const app = await createApplication(0);

    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/ip-probe')
        .set('X-Forwarded-For', '198.51.100.42')
        .expect(200);

      expect(response.body).not.toEqual({
        ip: '198.51.100.42',
      });
    } finally {
      await app.close();
    }
  });

  it('uses the forwarded client IP behind exactly one trusted proxy', async () => {
    const app = await createApplication(1);

    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/ip-probe')
        .set('X-Forwarded-For', '198.51.100.42')
        .expect(200);

      expect(response.body).toEqual({
        ip: '198.51.100.42',
      });
    } finally {
      await app.close();
    }
  });

  it.each(['', '-1', '1.5', 'invalid'])(
    'rejects invalid TRUST_PROXY_HOPS: %s',
    (value) => {
      expect(() => readTrustProxyHops(createConfig(value))).toThrow(
        'TRUST_PROXY_HOPS phải là số nguyên không âm',
      );
    },
  );
});
