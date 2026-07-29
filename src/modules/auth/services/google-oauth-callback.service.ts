import { Injectable } from '@nestjs/common';

import {
  GOOGLE_OAUTH_INTERNAL_USER_ID,
  GoogleOAuthAccountResolutionStatus,
} from '../interfaces/google-oauth-account-resolution.interface';
import {
  GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT,
  GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF,
  type GoogleOAuthCallbackInput,
  type GoogleOAuthCallbackResult,
} from '../interfaces/google-oauth-callback.interface';
import { GoogleOAuthAccountResolverService } from './google-oauth-account-resolver.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { GoogleOAuthProviderService } from './google-oauth-provider.service';
import { GoogleOAuthSignInService } from './google-oauth-sign-in.service';
import { GoogleOAuthTransactionService } from './google-oauth-transaction.service';

@Injectable()
export class GoogleOAuthCallbackService {
  constructor(
    private readonly transactionService: GoogleOAuthTransactionService,
    private readonly providerService: GoogleOAuthProviderService,
    private readonly accountResolverService: GoogleOAuthAccountResolverService,
    private readonly continuationGrantService: GoogleOAuthContinuationGrantService,
    private readonly signInService: GoogleOAuthSignInService,
  ) {}

  async handleCallback(
    input: GoogleOAuthCallbackInput,
  ): Promise<GoogleOAuthCallbackResult> {
    const transaction = await this.transactionService.consumeAuthorization(
      input.callbackState,
      input.browserState,
    );

    const identity = await this.providerService.exchangeAuthorizationCode(
      input.authorizationCode,
      transaction.codeVerifier,
      transaction.expectedNonceHash,
    );

    const resolution = await this.accountResolverService.resolve(identity);

    switch (resolution.status) {
      case GoogleOAuthAccountResolutionStatus.SIGN_IN: {
        const handoff = await this.signInService.signInLinkedAccount(
          identity.providerAccountId,
          resolution[GOOGLE_OAUTH_INTERNAL_USER_ID],
          input.metadata,
        );

        return {
          status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
          [GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF]: handoff,
        };
      }

      case GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED: {
        const grant = await this.continuationGrantService.issueLinkGrant({
          providerAccountId: identity.providerAccountId,
          email: resolution.email,
          targetUserId: resolution[GOOGLE_OAUTH_INTERNAL_USER_ID],
        });

        return {
          status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
          email: resolution.email,
          [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: grant,
        };
      }

      case GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED: {
        const grant =
          await this.continuationGrantService.issueRegistrationGrant({
            providerAccountId: identity.providerAccountId,
            email: resolution.profile.email,
            fullname: resolution.profile.fullname,
            avatar: resolution.profile.avatar,
          });

        return {
          status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
          profile: resolution.profile,
          [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: grant,
        };
      }

      default:
        return this.assertNever(resolution);
    }
  }

  async consumeRejectedCallback(
    callbackState: string,
    browserState: string,
  ): Promise<void> {
    await this.transactionService.consumeAuthorization(
      callbackState,
      browserState,
    );
  }

  private assertNever(resolution: never): never {
    void resolution;

    throw new TypeError('Unsupported Google OAuth account resolution');
  }
}
