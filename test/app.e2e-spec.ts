import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { ApiResponseInterceptor } from '../src/common/interceptors/api-response.interceptor';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  const allowedOrigin = 'https://app.betta.test';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: APP_INTERCEPTOR,
          useClass: ApiResponseInterceptor,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableCors({
      origin: [allowedOrigin],
      credentials: true,
    });
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET / trả success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: 'Hello World!',
    });
  });

  it('returns credentialed CORS headers only for an allowed exact origin', async () => {
    const allowedResponse = await request(app.getHttpServer())
      .options('/')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(allowedResponse.headers['access-control-allow-origin']).toBe(
      allowedOrigin,
    );
    expect(allowedResponse.headers['access-control-allow-credentials']).toBe(
      'true',
    );
    expect(allowedResponse.headers['access-control-allow-origin']).not.toBe(
      '*',
    );

    const rejectedResponse = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(
      rejectedResponse.headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});
