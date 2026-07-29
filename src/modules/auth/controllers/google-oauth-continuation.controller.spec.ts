import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { GoogleOAuthContinuationCookieInvalidException } from '../exceptions/google-oauth-continuation-cookie-invalid.exception';
import { GoogleOAuthContinuationGrantRejectedException } from '../exceptions/google-oauth-continuation-grant-rejected.exception';
import { GoogleOAuthContinuationOriginGuard } from '../guards/google-oauth-continuation-origin.guard';
import { GoogleOAuthContinuationGrantPurpose } from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthAccountLinkService } from '../services/google-oauth-account-link.service';
import { GoogleOAuthContinuationCookieService } from '../services/google-oauth-continuation-cookie.service';
import { GoogleOAuthRegistrationService } from '../services/google-oauth-registration.service';
import { GoogleOAuthContinuationController } from './google-oauth-continuation.controller';

const RAW_GRANT = 'a'.repeat(43);
const USER_ID = new Types.ObjectId();

const createContext = () => {
  const read = jest.fn<GoogleOAuthContinuationCookieService['read']>(
    () => RAW_GRANT,
  );

  const clear = jest.fn<GoogleOAuthContinuationCookieService['clear']>();

  const shouldClearAfterError = jest.fn<
    GoogleOAuthContinuationCookieService['shouldClearAfterError']
  >(
    (error) =>
      error instanceof GoogleOAuthContinuationCookieInvalidException ||
      error instanceof GoogleOAuthContinuationGrantRejectedException,
  );

  const linkGoogleAccount = jest.fn<
    GoogleOAuthAccountLinkService['linkGoogleAccount']
  >(() => Promise.resolve());

  const completeRegistration = jest.fn<
    GoogleOAuthRegistrationService['completeRegistration']
  >(() =>
    Promise.resolve({
      message: 'Đăng ký bằng Google thành công',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: {
        id: 'usr_google',
        publicId: 'usr_google',
        username: 'google.user',
        fullname: 'Google User',
        email: 'google@example.com',
        phone: '0912345678',
        avatar: null,
        hasCustomAvatar: false,
        streakCount: 0,
        status: 'active',
        notificationSettings: {
          enabled: true,
          follow: true,
          reaction: true,
          recap: true,
        },
      },
    }),
  );

  const controller = new GoogleOAuthContinuationController(
    {
      read,
      clear,
      shouldClearAfterError,
    } as unknown as GoogleOAuthContinuationCookieService,
    {
      linkGoogleAccount,
    } as unknown as GoogleOAuthAccountLinkService,
    {
      completeRegistration,
    } as unknown as GoogleOAuthRegistrationService,
  );

  const request = {
    headers: {},
    get: (name: string) =>
      name.toLowerCase() === 'user-agent' ? 'Test Browser' : undefined,
    user: {
      _id: USER_ID.toString(),
      id: USER_ID.toString(),
      email: 'user@example.com',
      username: 'user',
      sessionId: 'ses_12345678901234567890',
    },
  } as unknown as Request & AuthenticatedRequest;

  return {
    controller,
    request,
    response: {} as Response,
    mocks: {
      read,
      clear,
      linkGoogleAccount,
      completeRegistration,
    },
  };
};

const getControllerHandler = (
  name: 'linkAccount' | 'completeRegistration',
): ((...args: never[]) => unknown) => {
  const handler: unknown = Reflect.get(
    GoogleOAuthContinuationController.prototype,
    name,
  );

  if (typeof handler !== 'function') {
    throw new TypeError(`Controller handler ${name} không tồn tại`);
  }

  return handler as (...args: never[]) => unknown;
};

describe('GoogleOAuthContinuationController', () => {
  it('applies Origin globally and JWT only to link', () => {
    const reflector = new Reflector();

    expect(
      reflector.get<unknown[]>(
        GUARDS_METADATA,
        GoogleOAuthContinuationController,
      ),
    ).toContain(GoogleOAuthContinuationOriginGuard);

    expect(
      reflector.get<unknown[]>(
        GUARDS_METADATA,
        getControllerHandler('linkAccount'),
      ),
    ).toHaveLength(1);

    expect(
      reflector.get<unknown[]>(
        GUARDS_METADATA,
        getControllerHandler('completeRegistration'),
      ),
    ).toBeUndefined();
  });

  it('links authenticated user and clears cookie', async () => {
    const context = createContext();

    await context.controller.linkAccount(context.request, context.response);

    expect(context.mocks.read).toHaveBeenCalledWith(
      context.request,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
    );

    expect(context.mocks.linkGoogleAccount).toHaveBeenCalledTimes(1);

    const [rawGrant, authenticatedUserId] =
      context.mocks.linkGoogleAccount.mock.calls[0];

    expect(rawGrant).toBe(RAW_GRANT);
    expect(authenticatedUserId).toBeInstanceOf(Types.ObjectId);
    expect(authenticatedUserId.toString()).toBe(USER_ID.toString());

    expect(context.mocks.clear).toHaveBeenCalledWith(
      context.response,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
    );
  });

  it('completes registration and clears cookie', async () => {
    const context = createContext();

    const dto = {
      username: 'google.user',
      phone: '0912345678',
    };

    await context.controller.completeRegistration(
      context.request,
      context.response,
      dto,
    );

    expect(context.mocks.completeRegistration).toHaveBeenCalledWith(
      RAW_GRANT,
      dto,
      {
        userAgent: 'Test Browser',
      },
    );

    expect(context.mocks.clear).toHaveBeenCalledWith(
      context.response,
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
    );
  });

  it('clears a malformed continuation cookie', async () => {
    const context = createContext();
    const error = new GoogleOAuthContinuationCookieInvalidException();

    context.mocks.read.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      context.controller.linkAccount(context.request, context.response),
    ).rejects.toBe(error);

    expect(context.mocks.clear).toHaveBeenCalledWith(
      context.response,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
    );
  });

  it('clears a definitively rejected continuation grant', async () => {
    const context = createContext();
    const error = new GoogleOAuthContinuationGrantRejectedException();

    context.mocks.linkGoogleAccount.mockRejectedValueOnce(error);

    await expect(
      context.controller.linkAccount(context.request, context.response),
    ).rejects.toBe(error);

    expect(context.mocks.clear).toHaveBeenCalledWith(
      context.response,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
    );
  });

  it.each([
    new ConflictException(),
    new ServiceUnavailableException(),
    new Error('unknown'),
  ])('preserves cookie for non-final error', async (error) => {
    const context = createContext();

    context.mocks.linkGoogleAccount.mockImplementationOnce(() =>
      Promise.reject(error),
    );

    await expect(
      context.controller.linkAccount(context.request, context.response),
    ).rejects.toBe(error);

    expect(context.mocks.clear).not.toHaveBeenCalled();
  });
});
