import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';

import {
  GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT,
  GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF,
} from '../interfaces/google-oauth-callback.interface';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';
import {
  GOOGLE_OAUTH_INTERNAL_USER_ID,
  GoogleOAuthAccountResolutionStatus,
} from '../interfaces/google-oauth-account-resolution.interface';
import type { GoogleOAuthVerifiedIdentity } from '../interfaces/google-oauth-provider.interface';
import { GoogleOAuthAccountResolverService } from './google-oauth-account-resolver.service';
import { GoogleOAuthCallbackService } from './google-oauth-callback.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { GoogleOAuthProviderService } from './google-oauth-provider.service';
import { GoogleOAuthSignInService } from './google-oauth-sign-in.service';
import { GoogleOAuthTransactionService } from './google-oauth-transaction.service';

const IDENTITY: GoogleOAuthVerifiedIdentity = {
  providerAccountId: 'google-subject-123',
  email: 'user@example.com',
  fullname: 'Google User',
  avatar: 'https://example.com/avatar.jpg',
};

const HANDOFF: IssuedGoogleOAuthSessionHandoff = {
  rawHandoff: 'h'.repeat(43),
  expiresAt: new Date('2026-07-25T12:02:00.000Z'),
};

const createContext = () => {
  const userId = new Types.ObjectId();

  const consumeAuthorization = jest.fn<
    GoogleOAuthTransactionService['consumeAuthorization']
  >(() =>
    Promise.resolve({
      codeVerifier: 'v'.repeat(43),
      expectedNonceHash: 'n'.repeat(43),
    }),
  );

  const exchangeAuthorizationCode = jest.fn<
    GoogleOAuthProviderService['exchangeAuthorizationCode']
  >(() => Promise.resolve(IDENTITY));

  const resolve = jest.fn<GoogleOAuthAccountResolverService['resolve']>(() =>
    Promise.resolve({
      status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
      [GOOGLE_OAUTH_INTERNAL_USER_ID]: userId,
    }),
  );

  const issueLinkGrant = jest.fn<
    GoogleOAuthContinuationGrantService['issueLinkGrant']
  >(() =>
    Promise.resolve({
      rawGrant: 'g'.repeat(43),
      expiresAt: new Date('2026-07-25T12:10:00.000Z'),
    }),
  );

  const issueRegistrationGrant = jest.fn<
    GoogleOAuthContinuationGrantService['issueRegistrationGrant']
  >(() =>
    Promise.resolve({
      rawGrant: 'r'.repeat(43),
      expiresAt: new Date('2026-07-25T12:10:00.000Z'),
    }),
  );

  const signInLinkedAccount = jest.fn<
    GoogleOAuthSignInService['signInLinkedAccount']
  >(() => Promise.resolve(HANDOFF));

  const service = new GoogleOAuthCallbackService(
    { consumeAuthorization } as unknown as GoogleOAuthTransactionService,
    { exchangeAuthorizationCode } as unknown as GoogleOAuthProviderService,
    { resolve } as unknown as GoogleOAuthAccountResolverService,
    {
      issueLinkGrant,
      issueRegistrationGrant,
    } as unknown as GoogleOAuthContinuationGrantService,
    { signInLinkedAccount } as unknown as GoogleOAuthSignInService,
  );

  const execute = () =>
    service.handleCallback({
      authorizationCode: 'authorization-code',
      callbackState: 's'.repeat(43),
      browserState: 's'.repeat(43),
      metadata: {
        userAgent: 'Chrome Unit Test',
      },
    });

  return {
    execute,
    userId,
    consumeAuthorization,
    exchangeAuthorizationCode,
    resolve,
    issueLinkGrant,
    issueRegistrationGrant,
    signInLinkedAccount,
    service,
  };
};

describe('GoogleOAuthCallbackService', () => {
  it('orchestrates linked-account sign-in without exposing session data', async () => {
    const context = createContext();
    const result = await context.execute();

    expect(result.status).toBe(GoogleOAuthAccountResolutionStatus.SIGN_IN);

    if (result.status !== GoogleOAuthAccountResolutionStatus.SIGN_IN) {
      throw new Error('Expected Google OAuth sign-in result');
    }

    expect(result[GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF]).toEqual(HANDOFF);

    expect(context.consumeAuthorization).toHaveBeenCalledWith(
      's'.repeat(43),
      's'.repeat(43),
    );
    expect(context.exchangeAuthorizationCode).toHaveBeenCalledWith(
      'authorization-code',
      'v'.repeat(43),
      'n'.repeat(43),
    );
    expect(context.resolve).toHaveBeenCalledWith(IDENTITY);
    expect(context.signInLinkedAccount).toHaveBeenCalledWith(
      IDENTITY.providerAccountId,
      context.userId,
      {
        userAgent: 'Chrome Unit Test',
      },
    );

    const serialized = JSON.stringify(result);

    expect(serialized).toBe(
      JSON.stringify({
        status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
      }),
    );
    expect(serialized).not.toContain(HANDOFF.rawHandoff);
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(context.issueLinkGrant).not.toHaveBeenCalled();
    expect(context.issueRegistrationGrant).not.toHaveBeenCalled();
  });

  it('issues an internal-only account-link grant', async () => {
    const context = createContext();

    context.resolve.mockResolvedValue({
      status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
      email: 'user@example.com',
      [GOOGLE_OAUTH_INTERNAL_USER_ID]: context.userId,
    });

    const result = await context.execute();

    expect(result.status).toBe(
      GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
    );

    if (
      result.status !== GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED
    ) {
      throw new Error('Expected account-link callback result');
    }

    expect(context.issueLinkGrant).toHaveBeenCalledWith({
      providerAccountId: IDENTITY.providerAccountId,
      email: 'user@example.com',
      targetUserId: context.userId,
    });

    expect(result[GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]).toEqual(
      expect.objectContaining({
        rawGrant: 'g'.repeat(43),
      }),
    );

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('g'.repeat(43));
    expect(serialized).not.toContain(context.userId.toString());
    expect(serialized).not.toContain(IDENTITY.providerAccountId);
  });

  it('issues an internal-only registration grant', async () => {
    const context = createContext();

    context.resolve.mockResolvedValue({
      status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
      profile: {
        email: IDENTITY.email,
        fullname: IDENTITY.fullname,
        avatar: IDENTITY.avatar,
      },
    });

    const result = await context.execute();

    expect(result.status).toBe(
      GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
    );

    if (
      result.status !== GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED
    ) {
      throw new Error('Expected registration callback result');
    }

    expect(context.issueRegistrationGrant).toHaveBeenCalledWith({
      providerAccountId: IDENTITY.providerAccountId,
      email: IDENTITY.email,
      fullname: IDENTITY.fullname,
      avatar: IDENTITY.avatar,
    });

    expect(result[GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]).toEqual(
      expect.objectContaining({
        rawGrant: 'r'.repeat(43),
      }),
    );

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('r'.repeat(43));
    expect(serialized).not.toContain(IDENTITY.providerAccountId);
  });

  it('stops before Google exchange when state validation fails', async () => {
    const context = createContext();
    const error = new UnauthorizedException();

    context.consumeAuthorization.mockRejectedValue(error);

    await expect(context.execute()).rejects.toBe(error);

    expect(context.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(context.resolve).not.toHaveBeenCalled();
    expect(context.signInLinkedAccount).not.toHaveBeenCalled();
    expect(context.issueLinkGrant).not.toHaveBeenCalled();
    expect(context.issueRegistrationGrant).not.toHaveBeenCalled();
  });

  it('stops all downstream work when provider exchange fails', async () => {
    const context = createContext();
    const error = new UnauthorizedException();

    context.exchangeAuthorizationCode.mockRejectedValue(error);

    await expect(context.execute()).rejects.toBe(error);

    expect(context.resolve).not.toHaveBeenCalled();
    expect(context.signInLinkedAccount).not.toHaveBeenCalled();
    expect(context.issueLinkGrant).not.toHaveBeenCalled();
    expect(context.issueRegistrationGrant).not.toHaveBeenCalled();
  });

  it('consumes a rejected provider callback without contacting Google', async () => {
    const context = createContext();

    await expect(
      context.service.consumeRejectedCallback('s'.repeat(43), 's'.repeat(43)),
    ).resolves.toBeUndefined();

    expect(context.consumeAuthorization).toHaveBeenCalledWith(
      's'.repeat(43),
      's'.repeat(43),
    );

    expect(context.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(context.resolve).not.toHaveBeenCalled();
    expect(context.signInLinkedAccount).not.toHaveBeenCalled();
    expect(context.issueLinkGrant).not.toHaveBeenCalled();
    expect(context.issueRegistrationGrant).not.toHaveBeenCalled();
  });
});
