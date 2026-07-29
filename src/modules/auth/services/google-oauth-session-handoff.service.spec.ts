import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ClientSession, type Model } from 'mongoose';

import type { AuthResponse } from '../interfaces/auth.interface';
import { GoogleOAuthSessionHandoffInvalidException } from '../exceptions/google-oauth-session-handoff-invalid.exception';
import { GoogleOAuthSessionHandoff } from '../schemas/google-oauth-session-handoff.schema';
import { GoogleOAuthSessionHandoffService } from './google-oauth-session-handoff.service';

const NOW = new Date('2026-07-26T08:00:00.000Z');
const HANDOFF_KEY = Buffer.alloc(32, 1).toString('base64');
const TRANSACTION_KEY = Buffer.alloc(32, 2).toString('base64');
const VALID_RAW_HANDOFF = Buffer.alloc(32, 3).toString('base64url');

const AUTH_RESPONSE: AuthResponse = {
  message: 'Đăng nhập bằng Google thành công',
  access_token: 'access-token-secret',
  refresh_token: 'refresh-token-secret',
  user: {
    id: 'usr_google',
    publicId: 'usr_google',
    username: 'google_user',
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
};

type StoredEnvelope = {
  handoffHash: string;
  payloadVersion: number;
  payloadCiphertext: string;
  payloadIv: string;
  payloadAuthTag: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

type QueryStub<T> = {
  select: jest.Mock<(selection: string) => QueryStub<T>>;
  lean: jest.Mock<() => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type InsertMany = (
  documents: StoredEnvelope[],
  options: Record<string, unknown>,
) => Promise<unknown>;

type FindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Record<string, unknown>,
) => QueryStub<StoredEnvelope | null>;

const createQuery = <T>(result: T): QueryStub<T> => {
  const query = {
    select: jest.fn<(selection: string) => QueryStub<T>>(),
    lean: jest.fn<() => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(),
  };

  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  query.exec.mockResolvedValue(result);

  return query;
};

const createContext = (overrides: Record<string, string | undefined> = {}) => {
  const values: Record<string, string | undefined> = {
    GOOGLE_OAUTH_ENABLED: 'true',
    GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64: HANDOFF_KEY,
    GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS: '120',
    GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: TRANSACTION_KEY,
    JWT_SECRET: 'access-secret-different-from-handoff-key',
    JWT_REFRESH_SECRET: 'refresh-secret-different-from-handoff-key',
    ...overrides,
  };

  const insertMany = jest.fn<InsertMany>();
  const findOneAndUpdate = jest.fn<FindOneAndUpdate>();

  insertMany.mockResolvedValue([]);
  findOneAndUpdate.mockReturnValue(createQuery(null));

  const model = {
    insertMany,
    findOneAndUpdate,
  } as unknown as Model<GoogleOAuthSessionHandoff>;

  const configService = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  const service = new GoogleOAuthSessionHandoffService(model, configService);

  const transactionSession = {
    inTransaction: jest.fn(() => true),
  } as unknown as ClientSession;

  return {
    service,
    insertMany,
    findOneAndUpdate,
    transactionSession,
  };
};

const getInsertedEnvelope = (
  insertMany: jest.Mock<InsertMany>,
): StoredEnvelope => {
  const envelope = insertMany.mock.calls[0]?.[0]?.[0];

  if (!envelope) {
    throw new Error('Expected inserted handoff envelope');
  }

  return envelope;
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GoogleOAuthSessionHandoffService', () => {
  it('does not require handoff settings while Google OAuth is disabled', () => {
    expect(() =>
      createContext({
        GOOGLE_OAUTH_ENABLED: 'false',
        GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64: undefined,
        GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS: undefined,
      }),
    ).not.toThrow();
  });

  it.each([
    ['not-base64'],
    [Buffer.alloc(31, 1).toString('base64')],
    [Buffer.alloc(33, 1).toString('base64')],
    [Buffer.alloc(32, 1).toString('base64url')],
  ])('rejects invalid handoff key: %s', (key) => {
    expect(() =>
      createContext({
        GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64: key,
      }),
    ).toThrow(
      'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64 phải là Base64 canonical của khóa 32 byte',
    );
  });

  it('rejects a reused Google OAuth transaction key', () => {
    expect(() =>
      createContext({
        GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: HANDOFF_KEY,
      }),
    ).toThrow(
      'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64 không được dùng chung GOOGLE_OAUTH_TRANSACTION_KEY_BASE64',
    );
  });

  it.each(['59', '301', '1.5', 'abc'])(
    'rejects invalid handoff TTL: %s',
    (ttl) => {
      expect(() =>
        createContext({
          GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS: ttl,
        }),
      ).toThrow();
    },
  );

  it('requires an active transaction before issuing', async () => {
    const context = createContext();
    const inactiveSession = {
      inTransaction: jest.fn(() => false),
    } as unknown as ClientSession;

    await expect(
      context.service.issue(AUTH_RESPONSE, inactiveSession),
    ).rejects.toThrow(
      'Google OAuth session handoff issuance requires an active transaction',
    );

    expect(context.insertMany).not.toHaveBeenCalled();
  });

  it('stores only a hash and encrypted public AuthResponse', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const context = createContext();

    const issued = await context.service.issue(
      {
        ...AUTH_RESPONSE,
        user: {
          ...AUTH_RESPONSE.user,
          _id: 'mongodb-id-must-not-survive',
          googleSubject: 'google-subject-must-not-survive',
        },
      } as AuthResponse,
      context.transactionSession,
    );

    expect(issued.rawHandoff).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + 120_000));

    expect(context.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          handoffHash: expect.any(String),
          payloadCiphertext: expect.any(String),
          payloadIv: expect.any(String),
          payloadAuthTag: expect.any(String),
          expiresAt: issued.expiresAt,
          consumedAt: null,
        }),
      ],
      {
        ordered: true,
        session: context.transactionSession,
      },
    );

    const envelope = getInsertedEnvelope(context.insertMany);
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain(issued.rawHandoff);
    expect(serialized).not.toContain(AUTH_RESPONSE.access_token);
    expect(serialized).not.toContain(AUTH_RESPONSE.refresh_token);
    expect(serialized).not.toContain('mongodb-id-must-not-survive');
    expect(serialized).not.toContain('google-subject-must-not-survive');
  });

  it('consumes an issued handoff once and returns the exact public contract', async () => {
    const context = createContext();
    const issued = await context.service.issue(
      AUTH_RESPONSE,
      context.transactionSession,
    );
    const envelope = getInsertedEnvelope(context.insertMany);

    context.findOneAndUpdate
      .mockReturnValueOnce(createQuery(envelope))
      .mockReturnValueOnce(createQuery(null));

    await expect(context.service.consume(issued.rawHandoff)).resolves.toEqual(
      AUTH_RESPONSE,
    );

    await expect(
      context.service.consume(issued.rawHandoff),
    ).rejects.toBeInstanceOf(GoogleOAuthSessionHandoffInvalidException);
  });

  it('rejects malformed handoff before querying MongoDB', async () => {
    const context = createContext();

    await expect(
      context.service.consume('not-a-handoff'),
    ).rejects.toBeInstanceOf(GoogleOAuthSessionHandoffInvalidException);

    expect(context.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when the encrypted envelope is tampered', async () => {
    const context = createContext();
    const issued = await context.service.issue(
      AUTH_RESPONSE,
      context.transactionSession,
    );
    const envelope = getInsertedEnvelope(context.insertMany);

    context.findOneAndUpdate
      .mockReturnValueOnce(
        createQuery({
          ...envelope,
          payloadAuthTag: 'A'.repeat(22),
        }),
      )
      .mockReturnValueOnce(createQuery(null));

    await expect(
      context.service.consume(issued.rawHandoff),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    await expect(
      context.service.consume(issued.rawHandoff),
    ).rejects.toBeInstanceOf(GoogleOAuthSessionHandoffInvalidException);
  });

  it('maps issue persistence failures to a generic 503', async () => {
    const context = createContext();

    context.insertMany.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      context.service.issue(AUTH_RESPONSE, context.transactionSession),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps consume storage failures to a generic 503', async () => {
    const context = createContext();
    const query = createQuery<StoredEnvelope | null>(null);

    query.exec.mockRejectedValueOnce(new Error('database unavailable'));
    context.findOneAndUpdate.mockReturnValueOnce(query);

    await expect(
      context.service.consume(VALID_RAW_HANDOFF),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
