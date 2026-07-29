import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

export const GOOGLE_OAUTH_HTTP_TIMEOUT_MS = 10_000;

export const GOOGLE_ID_TOKEN_ISSUERS = Object.freeze([
  'accounts.google.com',
  'https://accounts.google.com',
]);

@Injectable()
export class GoogleOAuthClientFactory {
  create(
    clientId: string,
    clientSecret: string,
    callbackUrl: string,
  ): OAuth2Client {
    return new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri: callbackUrl,
      issuers: [...GOOGLE_ID_TOKEN_ISSUERS],
      transporterOptions: {
        timeout: GOOGLE_OAUTH_HTTP_TIMEOUT_MS,
        retryConfig: {
          retry: 0,
        },
      },

      /*
       * Không cài interceptor logging mặc định của SDK.
       * Token-exchange response có thể chứa provider token.
       */
      useAuthRequestParameters: false,
    });
  }
}
