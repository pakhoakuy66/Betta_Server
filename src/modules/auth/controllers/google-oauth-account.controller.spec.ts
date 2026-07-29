import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { AuthRateLimitService } from '../services/auth-rate-limit.service';
import { GoogleOAuthAccountUnlinkService } from '../services/google-oauth-account-unlink.service';
import { GoogleOAuthAccountController } from './google-oauth-account.controller';

const USER_ID = new Types.ObjectId('6a661963b935314f1141a514');
const CURRENT_PASSWORD = 'CurrentPassword123.';

type AuthenticatedExpressRequest = Request & AuthenticatedRequest;

const createContext = () => {
  const consumeGoogleOAuthUnlink =
    jest.fn<AuthRateLimitService['consumeGoogleOAuthUnlink']>();

  const unlinkGoogleAccount =
    jest.fn<GoogleOAuthAccountUnlinkService['unlinkGoogleAccount']>();

  consumeGoogleOAuthUnlink.mockResolvedValue();
  unlinkGoogleAccount.mockResolvedValue();

  const controller = new GoogleOAuthAccountController(
    {
      consumeGoogleOAuthUnlink,
    } as unknown as AuthRateLimitService,
    {
      unlinkGoogleAccount,
    } as unknown as GoogleOAuthAccountUnlinkService,
  );

  const setHeader = jest.fn<(name: string, value: string) => void>();

  const request = {
    ip: '::ffff:203.0.113.10',
    socket: {},
    user: {
      _id: USER_ID.toString(),
      id: USER_ID.toString(),
      email: 'user@example.com',
      username: 'user',
      sessionId: 'ses_12345678901234567890',
    },
  } as unknown as AuthenticatedExpressRequest;

  const response = {
    setHeader,
  } as unknown as Response;

  return {
    controller,
    request,
    response,
    setHeader,
    consumeGoogleOAuthUnlink,
    unlinkGoogleAccount,
  };
};

describe('GoogleOAuthAccountController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is protected by an authentication guard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      GoogleOAuthAccountController,
    ) as unknown[] | undefined;

    expect(guards).toHaveLength(1);
  });

  it('rate limits before unlinking and returns a public contract', async () => {
    const context = createContext();

    const result = await context.controller.unlinkAccount(
      context.request,
      context.response,
      {
        currentPassword: CURRENT_PASSWORD,
      },
    );

    expect(context.consumeGoogleOAuthUnlink).toHaveBeenCalledWith(
      '::ffff:203.0.113.10',
      USER_ID.toString(),
    );

    expect(context.unlinkGoogleAccount).toHaveBeenCalledTimes(1);

    const [calledUserId, calledPassword] =
      context.unlinkGoogleAccount.mock.calls[0];

    expect(calledUserId).toBeInstanceOf(Types.ObjectId);
    expect(calledUserId.toString()).toBe(USER_ID.toString());
    expect(calledPassword).toBe(CURRENT_PASSWORD);

    expect(
      context.consumeGoogleOAuthUnlink.mock.invocationCallOrder[0],
    ).toBeLessThan(context.unlinkGoogleAccount.mock.invocationCallOrder[0]);

    expect(result).toEqual({
      success: true,
      data: null,
      message: 'Đã hủy liên kết tài khoản Google',
    });

    expect(JSON.stringify(result)).not.toContain(USER_ID.toString());
    expect(JSON.stringify(result)).not.toContain(CURRENT_PASSWORD);
  });

  it('sets private response headers', async () => {
    const context = createContext();

    await context.controller.unlinkAccount(context.request, context.response, {
      currentPassword: CURRENT_PASSWORD,
    });

    expect(context.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(context.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(context.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
    expect(context.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
  });

  it('rejects an invalid authenticated user before rate limiting', async () => {
    const context = createContext();

    context.request.user._id = 'invalid-object-id';

    await expect(
      context.controller.unlinkAccount(context.request, context.response, {
        currentPassword: CURRENT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(context.consumeGoogleOAuthUnlink).not.toHaveBeenCalled();
    expect(context.unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it('does not call unlink when rate limiting rejects', async () => {
    const context = createContext();
    const error = new ServiceUnavailableException();

    context.consumeGoogleOAuthUnlink.mockRejectedValueOnce(error);

    await expect(
      context.controller.unlinkAccount(context.request, context.response, {
        currentPassword: CURRENT_PASSWORD,
      }),
    ).rejects.toBe(error);

    expect(context.unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it('preserves unlink business errors', async () => {
    const context = createContext();
    const error = new ConflictException();

    context.unlinkGoogleAccount.mockRejectedValueOnce(error);

    await expect(
      context.controller.unlinkAccount(context.request, context.response, {
        currentPassword: CURRENT_PASSWORD,
      }),
    ).rejects.toBe(error);
  });
});
