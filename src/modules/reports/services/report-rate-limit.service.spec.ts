import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { ReportRateLimitException } from '../exceptions/report-rate-limit.exception';
import { ReportRateLimit } from '../schemas/report-rate-limit.schema';
import { ReportRateLimitService } from './report-rate-limit.service';

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type RateLimitModelMock = {
  findOneAndUpdate: Mock<(...args: unknown[]) => unknown>;
};

const REPORTER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const TARGET_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');

const NOW = new Date('2026-07-15T03:00:00.000Z');
const SAFE_SECRET = 'a'.repeat(48);

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error === undefined ? Promise.resolve(value) : Promise.reject(error),
  );

  return query;
};

const createConfig = (
  overrides: Record<string, string> = {},
): ConfigService => {
  const values: Record<string, string> = {
    REPORT_RATE_LIMIT_HASH_SECRET: SAFE_SECRET,
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
};

const createContext = (configOverrides: Record<string, string> = {}) => {
  const model: RateLimitModelMock = {
    findOneAndUpdate: jest.fn(),
  };

  const service = new ReportRateLimitService(
    model as unknown as Model<ReportRateLimit>,
    createConfig(configOverrides),
  );

  return {
    service,
    model,
  };
};

describe('ReportRateLimitService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('fails closed when the hash secret is unsafe', () => {
      const model: RateLimitModelMock = {
        findOneAndUpdate: jest.fn(),
      };

      expect(
        () =>
          new ReportRateLimitService(
            model as unknown as Model<ReportRateLimit>,
            createConfig({
              REPORT_RATE_LIMIT_HASH_SECRET: 'short-secret',
            }),
          ),
      ).toThrow('REPORT_RATE_LIMIT_HASH_SECRET chưa được cấu hình an toàn');
    });

    it('rejects a policy whose IP limit is lower than user limit', () => {
      expect(() =>
        createContext({
          REPORT_CONTENT_USER_LIMIT: '10',
          REPORT_CONTENT_IP_LIMIT: '5',
          REPORT_CONTENT_DISTINCT_TARGET_LIMIT: '5',
        }),
      ).toThrow('content_report: ipLimit không được nhỏ hơn userLimit');
    });

    it('rejects non-positive integer configuration', () => {
      expect(() =>
        createContext({
          REPORT_CONTENT_WINDOW_SECONDS: '0',
        }),
      ).toThrow('REPORT_CONTENT_WINDOW_SECONDS phải là số nguyên dương');
    });
  });

  describe('consumeContentReport', () => {
    it('applies user, IP and distinct-target counters', async () => {
      const { service, model } = createContext();

      model.findOneAndUpdate
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(
          createQuery({
            count: 1,
            targetKeys: ['hashed-target'],
          }),
        );

      await expect(
        service.consumeContentReport({
          reporterId: REPORTER_ID,
          clientIp: '203.0.113.10',
          targetType: 'POST',
          targetId: TARGET_ID,
        }),
      ).resolves.toBeUndefined();

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);

      const serializedCalls = JSON.stringify(model.findOneAndUpdate.mock.calls);

      expect(serializedCalls).toContain('content_report:user');
      expect(serializedCalls).toContain('content_report:ip');
      expect(serializedCalls).toContain('content_report:targets');

      // IP và target discriminator phải được HMAC trước khi lưu.
      expect(serializedCalls).not.toContain('203.0.113.10');
      expect(serializedCalls).not.toContain(`POST:${TARGET_ID.toString()}`);
    });

    it('continues with user and target limits when IP is unavailable', async () => {
      const { service, model } = createContext();

      model.findOneAndUpdate
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(
          createQuery({
            count: 1,
            targetKeys: ['hashed-target'],
          }),
        );

      await expect(
        service.consumeContentReport({
          reporterId: REPORTER_ID,
          clientIp: 'not-an-ip',
          targetType: 'USER',
          targetId: TARGET_ID,
        }),
      ).resolves.toBeUndefined();

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

      const serializedCalls = JSON.stringify(model.findOneAndUpdate.mock.calls);

      expect(serializedCalls).toContain('content_report:user');
      expect(serializedCalls).toContain('content_report:targets');
      expect(serializedCalls).not.toContain('content_report:ip');
    });

    it('stops immediately when the user quota is exceeded', async () => {
      const { service, model } = createContext({
        REPORT_CONTENT_USER_LIMIT: '1',
        REPORT_CONTENT_IP_LIMIT: '2',
        REPORT_CONTENT_DISTINCT_TARGET_LIMIT: '1',
      });

      model.findOneAndUpdate.mockReturnValue(createQuery({ count: 2 }));

      await expect(
        service.consumeContentReport({
          reporterId: REPORTER_ID,
          clientIp: '203.0.113.10',
          targetType: 'POST',
          targetId: TARGET_ID,
        }),
      ).rejects.toBeInstanceOf(ReportRateLimitException);

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('rejects when the distinct-target quota is exceeded', async () => {
      const { service, model } = createContext({
        REPORT_CONTENT_USER_LIMIT: '2',
        REPORT_CONTENT_IP_LIMIT: '3',
        REPORT_CONTENT_DISTINCT_TARGET_LIMIT: '1',
      });

      model.findOneAndUpdate
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(
          createQuery({
            count: 2,
            targetKeys: ['target-a', 'target-b'],
          }),
        );

      await expect(
        service.consumeContentReport({
          reporterId: REPORTER_ID,
          clientIp: '203.0.113.10',
          targetType: 'POST',
          targetId: TARGET_ID,
        }),
      ).rejects.toBeInstanceOf(ReportRateLimitException);

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);
    });
  });

  describe('counter persistence', () => {
    it('recovers from an upsert duplicate-key race', async () => {
      const { service, model } = createContext();

      const duplicateKeyError = Object.assign(
        new Error('Duplicate rate-limit key'),
        {
          code: 11000,
        },
      );

      model.findOneAndUpdate
        .mockReturnValueOnce(createQuery(null, duplicateKeyError))
        .mockReturnValueOnce(createQuery({ count: 1 }))
        .mockReturnValueOnce(createQuery({ count: 1 }));

      await expect(
        service.consumeSystemUpload({
          reporterId: REPORTER_ID,
          clientIp: '203.0.113.10',
        }),
      ).resolves.toBeUndefined();

      // Upsert user + fallback update user + IP counter.
      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);

      expect(model.findOneAndUpdate.mock.calls[1]?.[2]).toEqual({
        returnDocument: 'after',
      });
    });

    it('fails closed when the counter cannot be persisted', async () => {
      const { service, model } = createContext();

      model.findOneAndUpdate.mockReturnValue(createQuery(null));

      await expect(
        service.consumeSystemUpload({
          reporterId: REPORTER_ID,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Initial attempt cộng với hai retry.
      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);
    });
  });
});
