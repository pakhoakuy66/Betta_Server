import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET / trả success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: 'Hello World!',
    });
  });
});
