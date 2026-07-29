import { describe, expect, it, jest } from '@jest/globals';
import { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_OAUTH_HTTP_TIMEOUT_MS,
  GoogleOAuthClientFactory,
} from './google-oauth-client.factory';

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(),
}));

describe('GoogleOAuthClientFactory', () => {
  it('creates a bounded non-retrying client', () => {
    const factory = new GoogleOAuthClientFactory();

    factory.create(
      'google-client-id',
      'google-client-secret',
      'https://api.betta.example/callback',
    );

    expect(OAuth2Client).toHaveBeenCalledTimes(1);

    expect(OAuth2Client).toHaveBeenCalledWith({
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      redirectUri: 'https://api.betta.example/callback',
      issuers: [...GOOGLE_ID_TOKEN_ISSUERS],
      transporterOptions: {
        timeout: GOOGLE_OAUTH_HTTP_TIMEOUT_MS,
        retryConfig: {
          retry: 0,
        },
      },
      useAuthRequestParameters: false,
    });
  });
});
