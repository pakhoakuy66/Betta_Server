import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';
import {
  type Credentials,
  type GetTokenOptions,
  type LoginTicket,
  type OAuth2Client,
  type TokenPayload,
  type VerifyIdTokenOptions,
} from 'google-auth-library';
import { type GoogleOAuthProviderConfiguration } from '../interfaces/google-oauth-transaction.interface';
import { GoogleOAuthClientFactory } from './google-oauth-client.factory';
import { GoogleOAuthProviderService } from './google-oauth-provider.service';
import { GoogleOAuthTransactionService } from './google-oauth-transaction.service';

const CLIENT_ID = 'google-client-id';
const CLIENT_SECRET = 'google-client-secret';

const CALLBACK_URL = 'https://api.betta.example/api/v1/auth/google/callback';

const AUTHORIZATION_CODE = 'authorization-code';

const CODE_VERIFIER = 'v'.repeat(43);
const EXPECTED_NONCE_HASH = 'h'.repeat(43);
const NONCE = 'n'.repeat(43);

const ID_TOKEN = 'sensitive-google-id-token';

const DEFAULT_CONFIGURATION: GoogleOAuthProviderConfiguration = {
  clientId: CLIENT_ID,
  callbackUrl: CALLBACK_URL,
};

const DEFAULT_PAYLOAD: TokenPayload = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: 'google-subject-123',
  iat: 1_800_000_000,
  exp: 1_800_003_600,
  email: 'User@Example.com',
  email_verified: true,
  nonce: NONCE,
  name: 'Google User',
  picture: 'https://example.com/avatar.jpg',
};

type ContextOverrides = {
  configuration?: GoogleOAuthProviderConfiguration | null;

  secret?: string;
  payload?: TokenPayload | undefined;
  nonceMatches?: boolean;
};

type MockGetTokenResponse = {
  tokens: Credentials;
  res: null;
};

const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.hasOwn(value, property);

const createContext = (overrides: ContextOverrides = {}) => {
  const configuration = hasOwn(overrides, 'configuration')
    ? overrides.configuration
    : DEFAULT_CONFIGURATION;

  const secret = hasOwn(overrides, 'secret') ? overrides.secret : CLIENT_SECRET;

  const payload = hasOwn(overrides, 'payload')
    ? overrides.payload
    : DEFAULT_PAYLOAD;

  const getToken = jest.fn<
    (options: GetTokenOptions) => Promise<MockGetTokenResponse>
  >(() =>
    Promise.resolve({
      tokens: {
        id_token: ID_TOKEN,
        access_token: 'sensitive-access-token',
        refresh_token: 'sensitive-refresh-token',
      },
      res: null,
    }),
  );

  const ticket = {
    getPayload: jest.fn<() => TokenPayload | undefined>(() => payload),
  } as unknown as LoginTicket;

  const verifyIdToken = jest.fn<
    (options: VerifyIdTokenOptions) => Promise<LoginTicket>
  >(() => Promise.resolve(ticket));

  const client = {
    getToken,
    verifyIdToken,
  } as unknown as OAuth2Client;

  const createClient = jest.fn<
    (
      clientId: string,
      clientSecret: string,
      callbackUrl: string,
    ) => OAuth2Client
  >(() => client);

  const clientFactory = {
    create: createClient,
  } as unknown as GoogleOAuthClientFactory;

  const getProviderConfiguration = jest.fn(() => configuration);

  const matchesNonce = jest.fn<
    (nonce: string, expectedNonceHash: string) => boolean
  >(() => overrides.nonceMatches ?? true);

  const transactionService = {
    getProviderConfiguration,
    matchesNonce,
  } as unknown as GoogleOAuthTransactionService;

  const configService = {
    get: jest.fn((key: string): string | undefined =>
      key === 'GOOGLE_OAUTH_CLIENT_SECRET' ? secret : undefined,
    ),
  } as unknown as ConfigService;

  const service = new GoogleOAuthProviderService(
    configService,
    transactionService,
    clientFactory,
  );

  return {
    service,
    getToken,
    verifyIdToken,
    createClient,
    matchesNonce,
  };
};

const execute = (service: GoogleOAuthProviderService) =>
  service.exchangeAuthorizationCode(
    AUTHORIZATION_CODE,
    CODE_VERIFIER,
    EXPECTED_NONCE_HASH,
  );

describe('GoogleOAuthProviderService', () => {
  it('does not create a client when OAuth is disabled', async () => {
    const { service, createClient } = createContext({
      configuration: null,
      secret: undefined,
    });

    expect(createClient).not.toHaveBeenCalled();

    await expect(execute(service)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([
    undefined,
    '',
    ' secret',
    'secret ',
    'sec\tret',
    'sec\nret',
    `secret\0value`,
    'x'.repeat(2049),
  ])('rejects invalid client secret: %p', (secret) => {
    expect(() => createContext({ secret })).toThrow(
      'GOOGLE_OAUTH_CLIENT_SECRET không hợp lệ',
    );
  });

  it('exchanges and verifies authorization code', async () => {
    const { service, getToken, verifyIdToken, createClient, matchesNonce } =
      createContext();

    await expect(execute(service)).resolves.toEqual({
      providerAccountId: 'google-subject-123',
      email: 'user@example.com',
      fullname: 'Google User',
      avatar: 'https://example.com/avatar.jpg',
    });

    expect(createClient).toHaveBeenCalledTimes(1);

    expect(createClient).toHaveBeenCalledWith(
      CLIENT_ID,
      CLIENT_SECRET,
      CALLBACK_URL,
    );

    expect(getToken).toHaveBeenCalledWith({
      code: AUTHORIZATION_CODE,
      codeVerifier: CODE_VERIFIER,
      redirect_uri: CALLBACK_URL,
    });

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: ID_TOKEN,
      audience: CLIENT_ID,
    });

    expect(matchesNonce).toHaveBeenCalledWith(NONCE, EXPECTED_NONCE_HASH);
  });

  it.each([
    ['code with spaces', CODE_VERIFIER],
    ['', CODE_VERIFIER],
    [AUTHORIZATION_CODE, 'invalid-verifier'],
    [AUTHORIZATION_CODE, 'x'.repeat(42)],
  ])('rejects malformed exchange input', async (code, verifier) => {
    const { service, getToken } = createContext();

    await expect(
      service.exchangeAuthorizationCode(code, verifier, EXPECTED_NONCE_HASH),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(getToken).not.toHaveBeenCalled();
  });

  it('rejects response without ID token', async () => {
    const { service, getToken } = createContext();

    getToken.mockResolvedValue({
      tokens: {},
      res: null,
    });

    await expect(execute(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects empty verified payload', async () => {
    const { service } = createContext({
      payload: undefined,
    });

    await expect(execute(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['missing nonce', { nonce: undefined }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['invalid subject', { sub: 'bad\nsub' }],
    ['too long subject', { sub: 's'.repeat(256) }],
    ['missing email', { email: undefined }],
    ['empty email', { email: ' ' }],
    [
      'too long email',
      {
        email: `${'a'.repeat(250)}@x.com`,
      },
    ],
    ['unverified email', { email_verified: false }],
    ['missing email verification', { email_verified: undefined }],
  ])('rejects invalid claim: %s', async (_name, changes) => {
    const payload = {
      ...DEFAULT_PAYLOAD,
      ...changes,
    } as TokenPayload;

    const { service } = createContext({
      payload,
    });

    await expect(execute(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects nonce mismatch', async () => {
    const { service } = createContext({
      nonceMatches: false,
    });

    await expect(execute(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([undefined, CLIENT_ID])(
    'accepts authorized party: %p',
    async (azp) => {
      const payload = {
        ...DEFAULT_PAYLOAD,
        azp,
      } as TokenPayload;

      const { service } = createContext({
        payload,
      });

      await expect(execute(service)).resolves.toMatchObject({
        providerAccountId: DEFAULT_PAYLOAD.sub,
      });
    },
  );

  it.each(['another-client-id', 123, null])(
    'rejects authorized party: %p',
    async (azp) => {
      const payload = {
        ...DEFAULT_PAYLOAD,
        azp,
      } as unknown as TokenPayload;

      const { service } = createContext({
        payload,
      });

      await expect(execute(service)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it.each([
    [
      'invalid_grant',
      {
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
          },
        },
      },
      UnauthorizedException,
    ],
    [
      'invalid_client',
      {
        response: {
          status: 401,
          data: {
            error: 'invalid_client',
          },
        },
      },
      ServiceUnavailableException,
    ],
    [
      '401 without body',
      {
        response: {
          status: 401,
          data: 'not-json',
        },
      },
      ServiceUnavailableException,
    ],
    [
      'invalid_request',
      {
        response: {
          status: 400,
          data: {
            error: 'invalid_request',
          },
        },
      },
      ServiceUnavailableException,
    ],
    [
      'invalid_scope',
      {
        response: {
          status: 400,
          data: {
            error: 'invalid_scope',
          },
        },
      },
      ServiceUnavailableException,
    ],
    [
      'unauthorized_client',
      {
        response: {
          status: 400,
          data: {
            error: 'unauthorized_client',
          },
        },
      },
      ServiceUnavailableException,
    ],
    [
      'unknown HTTP 400',
      {
        response: {
          status: 400,
          data: {
            error: 'unknown_error',
          },
        },
      },
      UnauthorizedException,
    ],
    [
      'HTTP 408',
      {
        response: {
          status: 408,
        },
      },
      ServiceUnavailableException,
    ],
    [
      'HTTP 429',
      {
        response: {
          status: 429,
        },
      },
      ServiceUnavailableException,
    ],
    [
      'HTTP 500',
      {
        response: {
          status: 500,
        },
      },
      ServiceUnavailableException,
    ],
    [
      'TimeoutError',
      {
        code: 'TimeoutError',
      },
      ServiceUnavailableException,
    ],
    [
      'nested network failure',
      {
        cause: {
          code: 'ENOTFOUND',
        },
      },
      ServiceUnavailableException,
    ],
  ])('maps token exchange error: %s', async (_name, error, exceptionType) => {
    const { service, getToken } = createContext();

    getToken.mockRejectedValue(error);

    await expect(execute(service)).rejects.toBeInstanceOf(exceptionType);
  });

  it('maps invalid ID token to 401', async () => {
    const { service, verifyIdToken } = createContext();

    verifyIdToken.mockRejectedValue(new Error('invalid signature'));

    await expect(execute(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps certificate timeout to 503', async () => {
    const { service, verifyIdToken } = createContext();

    verifyIdToken.mockRejectedValue({
      code: 'TimeoutError',
    });

    await expect(execute(service)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('removes unsafe fullname', async () => {
    const { service } = createContext({
      payload: {
        ...DEFAULT_PAYLOAD,
        name: 'Unsafe\nName',
      },
    });

    await expect(execute(service)).resolves.toMatchObject({
      fullname: null,
    });
  });

  it.each([
    'http://example.com/avatar.jpg',
    'not-a-valid-url',
    'https://user:password@example.com/avatar',
  ])('removes unsafe avatar: %s', async (picture) => {
    const { service } = createContext({
      payload: {
        ...DEFAULT_PAYLOAD,
        picture,
      },
    });

    await expect(execute(service)).resolves.toMatchObject({
      avatar: null,
    });
  });

  it('does not expose provider credentials in errors', async () => {
    const sensitiveValues = [
      AUTHORIZATION_CODE,
      CODE_VERIFIER,
      CLIENT_SECRET,
      ID_TOKEN,
      'sensitive-access-token',
      'sensitive-refresh-token',
      'provider-error-description',
    ];

    const { service, getToken } = createContext();

    getToken.mockRejectedValue({
      response: {
        status: 401,
        data: {
          error: 'invalid_client',
          error_description: 'provider-error-description',
          access_token: 'sensitive-access-token',
          refresh_token: 'sensitive-refresh-token',
          id_token: ID_TOKEN,
        },
      },
    });

    let thrown: unknown;

    try {
      await execute(service);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);

    const message = thrown instanceof Error ? thrown.message : String(thrown);

    for (const value of sensitiveValues) {
      expect(message).not.toContain(value);
    }
  });
});
