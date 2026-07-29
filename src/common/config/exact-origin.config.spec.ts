import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { parseExactOrigins, readExactCorsOrigins } from './exact-origin.config';

describe('exact-origin config', () => {
  it('normalizes, trims and deduplicates exact origins', () => {
    expect(
      parseExactOrigins(
        ' https://app.betta.test,https://api.betta.test,https://app.betta.test ',
        'test',
      ),
    ).toEqual(['https://app.betta.test', 'https://api.betta.test']);
  });

  it.each([
    '*',
    'https://app.betta.test/path',
    'https://app.betta.test?query=value',
    'https://app.betta.test/#fragment',
    'https://user:password@app.betta.test',
    'javascript:alert(1)',
    'not-an-origin',
  ])('rejects a non-exact origin: %s', (origin) => {
    expect(() => parseExactOrigins(origin, 'test')).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
  });

  it('requires HTTPS for every production origin', () => {
    expect(() =>
      parseExactOrigins('http://app.betta.test', 'production'),
    ).toThrow('Production CORS origins phải dùng HTTPS');

    expect(parseExactOrigins('https://app.betta.test', 'production')).toEqual([
      'https://app.betta.test',
    ]);
  });

  it('uses only the developer localhost default when config is absent', () => {
    const configService = new ConfigService({
      NODE_ENV: 'developer',
    });

    expect(readExactCorsOrigins(configService)).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('requires explicit origins in production', () => {
    const configService = new ConfigService({
      NODE_ENV: 'production',
    });

    expect(() => readExactCorsOrigins(configService)).toThrow(
      'CORS_ALLOWED_ORIGINS là bắt buộc trong production',
    );
  });

  it('rejects an unsupported environment name', () => {
    const configService = new ConfigService({
      NODE_ENV: 'staging',
      CORS_ALLOWED_ORIGINS: 'https://app.betta.test',
    });

    expect(() => readExactCorsOrigins(configService)).toThrow(
      'NODE_ENV phải là developer, test hoặc production',
    );
  });
});
