import { createCipheriv, createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type Model } from 'mongoose';
import { GoogleOAuthTransactionInvalidException } from '../exceptions/google-oauth-transaction-invalid.exception';
import { GoogleOAuthTransaction } from '../schemas/google-oauth-transaction.schema';
import { GoogleOAuthTransactionService } from './google-oauth-transaction.service';

const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const ENCODED_KEY = ENCRYPTION_KEY.toString('base64');

const VALID_STATE = 's'.repeat(43);
const VALID_NONCE = 'n'.repeat(43);

type Configuration = Record<string, string | undefined>;

type StoredSecrets = {
  nonceHash: string;
  codeVerifierCiphertext: string;
  codeVerifierIv: string;
  codeVerifierAuthTag: string;
};

type CreatedTransaction = StoredSecrets & {
  stateHash: string;
  expiresAt: Date;
  consumedAt: null;
};

type QueryMock = {
  select: jest.Mock<(fields: string) => QueryMock>;
  lean: jest.Mock<() => QueryMock>;
  exec: jest.Mock<() => Promise<StoredSecrets | null>>;
};

type ModelMocks = {
  create: jest.Mock<(payload: CreatedTransaction) => Promise<unknown>>;
  findOneAndUpdate: jest.Mock<
    (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => QueryMock
  >;
};

const baseConfiguration: Configuration = {
  GOOGLE_OAUTH_ENABLED: 'true',
  NODE_ENV: 'test',
  GOOGLE_OAUTH_CLIENT_ID: 'test-google-client-id',
  GOOGLE_OAUTH_CALLBACK_URL:
    'http://localhost:5000/api/v1/auth/google/callback',
  GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: ENCODED_KEY,
  GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS: '600',
};

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

const encryptForTest = (
  plaintext: string,
  stateHash: string,
  nonceHash: string,
): StoredSecrets => {
  const iv = Buffer.alloc(12, 5);

  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv, {
    authTagLength: 16,
  });

  cipher.setAAD(Buffer.from(`${stateHash}.${nonceHash}`, 'utf8'));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    nonceHash,
    codeVerifierCiphertext: encrypted.toString('base64url'),
    codeVerifierIv: iv.toString('base64url'),
    codeVerifierAuthTag: cipher.getAuthTag().toString('base64url'),
  };
};

const createContext = (overrides: Configuration = {}) => {
  const configuration = {
    ...baseConfiguration,
    ...overrides,
  };

  const query = {} as QueryMock;

  query.select = jest.fn<(fields: string) => QueryMock>(() => query);

  query.lean = jest.fn<() => QueryMock>(() => query);

  query.exec = jest.fn<() => Promise<StoredSecrets | null>>(() =>
    Promise.resolve(null),
  );

  const modelMocks: ModelMocks = {
    create: jest.fn<(payload: CreatedTransaction) => Promise<unknown>>(() =>
      Promise.resolve({}),
    ),
    findOneAndUpdate: jest.fn<
      (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => QueryMock
    >(() => query),
  };

  const configService = {
    get: jest.fn((key: string): string | undefined => configuration[key]),
  } as unknown as ConfigService;

  const service = new GoogleOAuthTransactionService(
    modelMocks as unknown as Model<GoogleOAuthTransaction>,
    configService,
  );

  return {
    service,
    modelMocks,
    query,
  };
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GoogleOAuthTransactionService', () => {
  it('does not require Google config when disabled', async () => {
    const { service } = createContext({
      GOOGLE_OAUTH_ENABLED: 'false',
      NODE_ENV: undefined,
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CALLBACK_URL: undefined,
      GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: undefined,
    });

    expect(service.getProviderConfiguration()).toBeNull();

    await expect(service.beginAuthorization()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each(['yes', '1', 'enabled'])(
    'rejects invalid GOOGLE_OAUTH_ENABLED: %s',
    (enabled) => {
      expect(() =>
        createContext({
          GOOGLE_OAUTH_ENABLED: enabled,
        }),
      ).toThrow('GOOGLE_OAUTH_ENABLED phải là true hoặc false');
    },
  );

  it.each([[undefined], ['development'], ['prodution'], ['']])(
    'rejects missing or invalid NODE_ENV: %s',
    (nodeEnvironment) => {
      expect(() =>
        createContext({
          NODE_ENV: nodeEnvironment,
        }),
      ).toThrow('NODE_ENV phải là developer, test hoặc production');
    },
  );

  it.each([
    ['production', 'http://api.betta.test/auth/google/callback'],
    ['production', 'https://localhost/auth/google/callback'],
    ['production', 'https://127.0.0.1/auth/google/callback'],
    ['production', 'https://[::1]/auth/google/callback'],
    ['developer', 'http://public.example.com/auth/google/callback'],
  ])('rejects unsafe callback for %s', (environment, callbackUrl) => {
    expect(() =>
      createContext({
        NODE_ENV: environment,
        GOOGLE_OAUTH_CALLBACK_URL: callbackUrl,
      }),
    ).toThrow();
  });

  it.each([
    'http://localhost:5000/api/v1/auth/google/callback',
    'http://auth.localhost:5000/api/v1/auth/google/callback',
    'http://127.23.45.67:5000/api/v1/auth/google/callback',
    'http://[::1]:5000/api/v1/auth/google/callback',
    'https://developer.betta.test/api/v1/auth/google/callback',
  ])('accepts developer callback %s', (callbackUrl) => {
    expect(() =>
      createContext({
        NODE_ENV: 'developer',
        GOOGLE_OAUTH_CALLBACK_URL: callbackUrl,
      }),
    ).not.toThrow();
  });

  it('accepts a production HTTPS non-loopback callback', () => {
    expect(() =>
      createContext({
        NODE_ENV: 'production',
        GOOGLE_OAUTH_CALLBACK_URL:
          'https://api.betta.example/api/v1/auth/google/callback',
      }),
    ).not.toThrow();
  });

  it.each([
    'http://localhost:5000/api/v1/auth/google/callback/',
    'http://localhost:5000/api/v1/auth/google/callback-v2',
    'http://localhost:5000/auth/google/callback',
  ])('rejects a callback URL with a different pathname: %s', (callbackUrl) => {
    expect(() =>
      createContext({
        NODE_ENV: 'developer',
        GOOGLE_OAUTH_CALLBACK_URL: callbackUrl,
      }),
    ).toThrow(
      'GOOGLE_OAUTH_CALLBACK_URL phải trỏ đúng Google OAuth callback path',
    );
  });

  it('exposes only canonical provider configuration', () => {
    const { service } = createContext({
      NODE_ENV: 'production',
      GOOGLE_OAUTH_CLIENT_ID: 'production-google-client-id',
      GOOGLE_OAUTH_CALLBACK_URL:
        'https://API.BETTA.EXAMPLE:443/api/v1/auth/google/callback',
    });

    expect(service.getProviderConfiguration()).toEqual({
      clientId: 'production-google-client-id',
      callbackUrl: 'https://api.betta.example/api/v1/auth/google/callback',
    });
  });

  it.each(['client id', 'client\tid', 'client\nid', 'x'.repeat(513)])(
    'rejects invalid Google client ID',
    (clientId) => {
      expect(() =>
        createContext({
          GOOGLE_OAUTH_CLIENT_ID: clientId,
        }),
      ).toThrow('GOOGLE_OAUTH_CLIENT_ID không hợp lệ');
    },
  );

  it.each([['299'], ['901'], ['600.5'], ['invalid']])(
    'rejects invalid transaction TTL: %s',
    (ttl) => {
      expect(() =>
        createContext({
          GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS: ttl,
        }),
      ).toThrow();
    },
  );

  it.each([
    ['not-base64'],
    [Buffer.alloc(31, 1).toString('base64')],
    [Buffer.alloc(33, 1).toString('base64')],
    [Buffer.alloc(32, 1).toString('base64url')],
  ])('rejects an invalid transaction encryption key', (encryptionKey) => {
    expect(() =>
      createContext({
        GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: encryptionKey,
      }),
    ).toThrow(
      'GOOGLE_OAUTH_TRANSACTION_KEY_BASE64 phải là Base64 canonical của khóa 32 byte',
    );
  });

  it('creates a correct authorization transaction', async () => {
    const { service, modelMocks, query } = createContext();

    const result = await service.beginAuthorization();

    expect(modelMocks.create).toHaveBeenCalledTimes(1);

    const payload = modelMocks.create.mock.calls[0][0];

    expect(result.browserState).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    expect(payload.stateHash).toBe(digest(result.browserState));

    expect(payload.stateHash).not.toBe(result.browserState);

    expect(payload.codeVerifierCiphertext).not.toBe(result.browserState);

    const url = new URL(result.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );

    expect(url.searchParams.get('response_type')).toBe('code');

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    expect(url.searchParams.get('state')).toBe(result.browserState);

    const nonce = url.searchParams.get('nonce');

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    expect(payload.nonceHash).toBe(digest(nonce as string));

    query.exec.mockResolvedValue({
      nonceHash: payload.nonceHash,
      codeVerifierCiphertext: payload.codeVerifierCiphertext,
      codeVerifierIv: payload.codeVerifierIv,
      codeVerifierAuthTag: payload.codeVerifierAuthTag,
    });

    const consumed = await service.consumeAuthorization(
      result.browserState,
      result.browserState,
    );

    expect(digest(consumed.codeVerifier)).toBe(
      url.searchParams.get('code_challenge'),
    );

    expect(
      service.matchesNonce(nonce as string, consumed.expectedNonceHash),
    ).toBe(true);
  });

  it('does not query MongoDB for a wrong browser state', async () => {
    const { service, modelMocks } = createContext();

    await expect(
      service.consumeAuthorization(VALID_STATE, 'x'.repeat(43)),
    ).rejects.toBeInstanceOf(GoogleOAuthTransactionInvalidException);

    expect(modelMocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('uses the exact atomic consume operation', async () => {
    const { service, modelMocks, query } = createContext();

    const stateHash = digest(VALID_STATE);
    const nonceHash = digest(VALID_NONCE);

    const secrets = encryptForTest('v'.repeat(43), stateHash, nonceHash);

    query.exec.mockResolvedValue(secrets);

    await service.consumeAuthorization(VALID_STATE, VALID_STATE);

    expect(modelMocks.findOneAndUpdate).toHaveBeenCalledTimes(1);

    expect(modelMocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        stateHash,
        consumedAt: null,
        expiresAt: {
          $gt: expect.any(Date),
        },
      },
      {
        $set: {
          consumedAt: expect.any(Date),
        },
      },
      {
        returnDocument: 'after',
      },
    );

    expect(query.select).toHaveBeenCalledWith(
      '+nonceHash +codeVerifierCiphertext +codeVerifierIv +codeVerifierAuthTag',
    );
  });

  it('returns a generic unauthorized error when no transaction wins', async () => {
    const { service } = createContext();

    await expect(
      service.consumeAuthorization(VALID_STATE, VALID_STATE),
    ).rejects.toBeInstanceOf(GoogleOAuthTransactionInvalidException);
  });

  it('fails closed for a malformed decrypted verifier', async () => {
    const { service, query } = createContext();

    const stateHash = digest(VALID_STATE);
    const nonceHash = digest(VALID_NONCE);

    query.exec.mockResolvedValue(
      encryptForTest('not-a-valid-verifier', stateHash, nonceHash),
    );

    await expect(
      service.consumeAuthorization(VALID_STATE, VALID_STATE),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed for a tampered auth tag', async () => {
    const { service, query } = createContext();

    const stateHash = digest(VALID_STATE);
    const nonceHash = digest(VALID_NONCE);

    const secrets = encryptForTest('v'.repeat(43), stateHash, nonceHash);

    query.exec.mockResolvedValue({
      ...secrets,
      codeVerifierAuthTag: 'A'.repeat(22),
    });

    await expect(
      service.consumeAuthorization(VALID_STATE, VALID_STATE),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('matches only the expected nonce', () => {
    const { service } = createContext();

    expect(service.matchesNonce(VALID_NONCE, digest(VALID_NONCE))).toBe(true);

    expect(service.matchesNonce('x'.repeat(43), digest(VALID_NONCE))).toBe(
      false,
    );

    expect(service.matchesNonce('invalid', digest(VALID_NONCE))).toBe(false);
  });

  it('does not log transaction secrets', async () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const { service } = createContext();

    await service.beginAuthorization();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
