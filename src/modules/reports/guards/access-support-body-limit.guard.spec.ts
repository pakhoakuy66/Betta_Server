import {
  type ExecutionContext,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';
import { ACCESS_SUPPORT_BODY_MAX_BYTES } from '../constants/access-support.constants';
import type { AccessSupportRateLimitService } from '../services/access-support-rate-limit.service';
import {
  type AccessSupportAttemptRequest,
  markAccessSupportIpAttempt,
} from '../utils/access-support-attempt.util';
import { AccessSupportBodyLimitGuard } from './access-support-body-limit.guard';

const buildContext = (options: {
  contentType?: string;
  rawBody?: Buffer;
  attemptAlreadyConsumed?: boolean;
}) => {
  const headers: Record<string, string | undefined> = {
    'content-type': options.contentType,
  };
  const request = {
    ip: '127.0.0.1',
    rawBody: options.rawBody,
    get: jest.fn((name: string) => headers[name.toLowerCase()]),
  } as unknown as AccessSupportAttemptRequest;
  if (options.attemptAlreadyConsumed) markAccessSupportIpAttempt(request);

  const setHeader = jest.fn<Response['setHeader']>();
  const response = { setHeader } as unknown as Response;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, setHeader };
};

describe('AccessSupportBodyLimitGuard', () => {
  const consumeIp = jest
    .fn<AccessSupportRateLimitService['consumeIp']>()
    .mockResolvedValue(undefined);
  const guard = new AccessSupportBodyLimitGuard({
    consumeIp,
  } as unknown as AccessSupportRateLimitService);

  it('accepts raw JSON and applies private response headers', async () => {
    const { context, setHeader } = buildContext({
      contentType: 'application/json; charset=utf-8',
      rawBody: Buffer.from('{"description":"safe"}', 'utf8'),
      attemptAlreadyConsumed: true,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consumeIp).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });

  it.each([undefined, 'multipart/form-data', 'text/plain'])(
    'counts the IP before rejecting non-JSON media type %s',
    async (contentType) => {
      consumeIp.mockClear();
      const { context, setHeader } = buildContext({ contentType });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
      expect(consumeIp).toHaveBeenCalledTimes(1);
      expect(setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-store, max-age=0',
      );
    },
  );

  it('uses raw bytes and rejects chunked-style whitespace inflation', async () => {
    const rawBody = Buffer.from(
      `{${' '.repeat(ACCESS_SUPPORT_BODY_MAX_BYTES)}"description":"safe"}`,
      'utf8',
    );
    const { context } = buildContext({
      contentType: 'application/json',
      rawBody,
      attemptAlreadyConsumed: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('fails closed when raw-body capture is missing', async () => {
    const { context } = buildContext({
      contentType: 'application/json',
      attemptAlreadyConsumed: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
