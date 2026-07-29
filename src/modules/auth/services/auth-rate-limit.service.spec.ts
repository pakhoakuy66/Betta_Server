import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { Model } from 'mongoose';

import { AuthRateLimit } from '../schemas/auth-rate-limit.schema';
import { AuthRateLimitService } from './auth-rate-limit.service';

type FindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<AuthRateLimit | null>;

const NOW = new Date('2026-07-25T12:00:00.000Z');

const SECRET = 'oauth-rate-limit-test-secret'.padEnd(48, 'x');

const createContext = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    AUTH_RATE_LIMIT_SECRET: SECRET,
    AUTH_LOGIN_IP_LIMIT: 20,
    AUTH_LOGIN_ACCOUNT_LIMIT: 10,
    AUTH_LOGIN_WINDOW_SECONDS: 900,
    AUTH_FORGOT_IP_LIMIT: 5,
    AUTH_FORGOT_ACCOUNT_LIMIT: 3,
    AUTH_FORGOT_WINDOW_SECONDS: 900,
    AUTH_OTP_IP_LIMIT: 20,
    AUTH_OTP_ACCOUNT_LIMIT: 8,
    AUTH_OTP_WINDOW_SECONDS: 600,
    AUTH_GOOGLE_OAUTH_START_IP_LIMIT: 20,
    AUTH_GOOGLE_OAUTH_START_WINDOW_SECONDS: 900,
    AUTH_GOOGLE_OAUTH_SESSION_IP_LIMIT: 30,
    AUTH_GOOGLE_OAUTH_SESSION_WINDOW_SECONDS: 300,
    AUTH_GOOGLE_OAUTH_UNLINK_IP_LIMIT: 20,
    AUTH_GOOGLE_OAUTH_UNLINK_USER_LIMIT: 8,
    AUTH_GOOGLE_OAUTH_UNLINK_WINDOW_SECONDS: 900,
    ...overrides,
  };

  const findOneAndUpdate = jest.fn<FindOneAndUpdate>(() =>
    Promise.resolve({
      count: 1,
    } as AuthRateLimit),
  );

  const model = {
    findOneAndUpdate,
  } as unknown as Model<AuthRateLimit>;

  const configService = {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;

  return {
    service: new AuthRateLimitService(model, configService),
    findOneAndUpdate,
  };
};

describe('AuthRateLimitService Google OAuth start', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses an isolated IP-only OAuth bucket', async () => {
    const { service, findOneAndUpdate } = createContext();

    await service.consumeGoogleOAuthStart('::ffff:203.0.113.10');

    const windowMs = 900 * 1000;
    const bucket = Math.floor(NOW.getTime() / windowMs);

    const expectedKeyHash = createHmac('sha256', SECRET)
      .update(`google-oauth-start:ip:203.0.113.10:${bucket}`)
      .digest('hex');

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        keyHash: expectedKeyHash,
      },
      {
        $inc: {
          count: 1,
        },
        $setOnInsert: {
          expiresAt: expect.any(Date),
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  });

  it('rejects requests above the OAuth start limit', async () => {
    const { service, findOneAndUpdate } = createContext({
      AUTH_GOOGLE_OAUTH_START_IP_LIMIT: 1,
    });

    findOneAndUpdate.mockResolvedValueOnce({
      count: 2,
    } as AuthRateLimit);

    const operation = service.consumeGoogleOAuthStart('203.0.113.10');

    await expect(operation).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it.each([0, -1, 1.5, 'invalid'])(
    'rejects invalid OAuth start limit: %s',
    (limit) => {
      expect(() =>
        createContext({
          AUTH_GOOGLE_OAUTH_START_IP_LIMIT: limit,
        }),
      ).toThrow('AUTH_GOOGLE_OAUTH_START_IP_LIMIT phải là số nguyên dương');
    },
  );

  it.each([0, -1, 1.5, 'invalid'])(
    'rejects invalid OAuth start window: %s',
    (windowSeconds) => {
      expect(() =>
        createContext({
          AUTH_GOOGLE_OAUTH_START_WINDOW_SECONDS: windowSeconds,
        }),
      ).toThrow(
        'AUTH_GOOGLE_OAUTH_START_WINDOW_SECONDS phải là số nguyên dương',
      );
    },
  );
});

describe('AuthRateLimitService Google OAuth session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses a separate IP-only session bucket', async () => {
    const { service, findOneAndUpdate } = createContext();

    await service.consumeGoogleOAuthSession('::ffff:203.0.113.10');

    const windowMs = 300 * 1_000;
    const bucket = Math.floor(NOW.getTime() / windowMs);

    const expectedKeyHash = createHmac('sha256', SECRET)
      .update(`google-oauth-session:ip:203.0.113.10:${bucket}`)
      .digest('hex');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        keyHash: expectedKeyHash,
      },
      {
        $inc: {
          count: 1,
        },
        $setOnInsert: {
          expiresAt: expect.any(Date),
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  });

  it('rejects requests above the session limit', async () => {
    const { service, findOneAndUpdate } = createContext({
      AUTH_GOOGLE_OAUTH_SESSION_IP_LIMIT: 1,
    });

    findOneAndUpdate.mockResolvedValueOnce({
      count: 2,
    } as AuthRateLimit);

    await expect(
      service.consumeGoogleOAuthSession('203.0.113.10'),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it.each([0, -1, 1.5, 'invalid'])(
    'rejects invalid session limit: %s',
    (limit) => {
      expect(() =>
        createContext({
          AUTH_GOOGLE_OAUTH_SESSION_IP_LIMIT: limit,
        }),
      ).toThrow('AUTH_GOOGLE_OAUTH_SESSION_IP_LIMIT');
    },
  );

  it.each([0, -1, 1.5, 'invalid'])(
    'rejects invalid session window: %s',
    (windowSeconds) => {
      expect(() =>
        createContext({
          AUTH_GOOGLE_OAUTH_SESSION_WINDOW_SECONDS: windowSeconds,
        }),
      ).toThrow('AUTH_GOOGLE_OAUTH_SESSION_WINDOW_SECONDS');
    },
  );
});

describe('AuthRateLimitService Google OAuth unlink', () => {
  const userId = '6a661963b935314f1141a514';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses isolated HMAC buckets for IP and authenticated user', async () => {
    const { service, findOneAndUpdate } = createContext();

    await service.consumeGoogleOAuthUnlink('::ffff:203.0.113.10', userId);

    const windowMs = 900 * 1_000;
    const bucket = Math.floor(NOW.getTime() / windowMs);

    const expectedIpKeyHash = createHmac('sha256', SECRET)
      .update(`google-oauth-unlink:ip:203.0.113.10:${bucket}`)
      .digest('hex');

    const expectedUserKeyHash = createHmac('sha256', SECRET)
      .update(`google-oauth-unlink:user:${userId}:${bucket}`)
      .digest('hex');

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);

    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      {
        keyHash: expectedIpKeyHash,
      },
      {
        $inc: {
          count: 1,
        },
        $setOnInsert: {
          expiresAt: expect.any(Date),
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        keyHash: expectedUserKeyHash,
      },
      {
        $inc: {
          count: 1,
        },
        $setOnInsert: {
          expiresAt: expect.any(Date),
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    expect(JSON.stringify(findOneAndUpdate.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(findOneAndUpdate.mock.calls)).not.toContain(
      '203.0.113.10',
    );
  });

  it('rejects requests above the per-user unlink limit', async () => {
    const { service, findOneAndUpdate } = createContext({
      AUTH_GOOGLE_OAUTH_UNLINK_USER_LIMIT: 1,
    });

    findOneAndUpdate
      .mockResolvedValueOnce({
        count: 1,
      } as AuthRateLimit)
      .mockResolvedValueOnce({
        count: 2,
      } as AuthRateLimit);

    await expect(
      service.consumeGoogleOAuthUnlink('203.0.113.10', userId),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('rejects requests above the per-IP unlink limit', async () => {
    const { service, findOneAndUpdate } = createContext({
      AUTH_GOOGLE_OAUTH_UNLINK_IP_LIMIT: 1,
    });

    findOneAndUpdate
      .mockResolvedValueOnce({
        count: 2,
      } as AuthRateLimit)
      .mockResolvedValueOnce({
        count: 1,
      } as AuthRateLimit);

    await expect(
      service.consumeGoogleOAuthUnlink('203.0.113.10', userId),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty authenticated user key', async () => {
    const { service, findOneAndUpdate } = createContext();

    await expect(
      service.consumeGoogleOAuthUnlink('203.0.113.10', '   '),
    ).rejects.toBeInstanceOf(TypeError);

    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTH_GOOGLE_OAUTH_UNLINK_IP_LIMIT', 0],
    ['AUTH_GOOGLE_OAUTH_UNLINK_IP_LIMIT', 1.5],
    ['AUTH_GOOGLE_OAUTH_UNLINK_USER_LIMIT', -1],
    ['AUTH_GOOGLE_OAUTH_UNLINK_USER_LIMIT', 'invalid'],
    ['AUTH_GOOGLE_OAUTH_UNLINK_WINDOW_SECONDS', 0],
    ['AUTH_GOOGLE_OAUTH_UNLINK_WINDOW_SECONDS', 'invalid'],
  ])('rejects invalid configuration %s=%s', (key, value) => {
    expect(() =>
      createContext({
        [key]: value,
      }),
    ).toThrow(`${key} phải là số nguyên dương`);
  });
});
