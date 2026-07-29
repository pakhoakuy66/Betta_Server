import { createHash, randomUUID } from 'node:crypto';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, createConnection, type Model } from 'mongoose';
import {
  GoogleOAuthTransaction,
  GoogleOAuthTransactionSchema,
} from '../../src/modules/auth/schemas/google-oauth-transaction.schema';
import { GoogleOAuthTransactionService } from '../../src/modules/auth/services/google-oauth-transaction.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_lc_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid.toString(36)}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const assertSafeDatabaseName = (value: string): void => {
  if (
    !value.startsWith(DATABASE_PREFIX) ||
    Buffer.byteLength(value, 'utf8') > MAX_DATABASE_NAME_BYTES
  ) {
    throw new Error(`Tên integration database không an toàn: ${value}`);
  }
};

const ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

jest.setTimeout(60_000);

describe('Google OAuth transaction lifecycle MongoDB integration', () => {
  let connection: Connection;
  let model: Model<GoogleOAuthTransaction>;
  let service: GoogleOAuthTransactionService;

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }

    assertSafeDatabaseName(databaseName);

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    model = connection.model<GoogleOAuthTransaction>(
      'GoogleOAuthLifecycleIntegration',
      GoogleOAuthTransactionSchema.clone(),
    );

    await model.syncIndexes();

    const configuration: Record<string, string> = {
      GOOGLE_OAUTH_ENABLED: 'true',
      NODE_ENV: 'test',
      GOOGLE_OAUTH_CLIENT_ID: 'integration-client-id',
      GOOGLE_OAUTH_CALLBACK_URL:
        'http://localhost:5000/api/v1/auth/google/callback',
      GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: ENCRYPTION_KEY,
      GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS: '600',
    };

    const configService = {
      get: (key: string): string | undefined => configuration[key],
    } as ConfigService;

    service = new GoogleOAuthTransactionService(model, configService);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    try {
      assertSafeDatabaseName(connection.name);
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('stores an encrypted transaction without raw secrets', async () => {
    const started = await service.beginAuthorization();

    const url = new URL(started.authorizationUrl);

    const nonce = url.searchParams.get('nonce');

    expect(nonce).toBeTruthy();

    const stateHash = digest(started.browserState);

    const stored = await model
      .findOne({ stateHash })
      .select(
        '+stateHash +nonceHash +codeVerifierCiphertext +codeVerifierIv +codeVerifierAuthTag',
      )
      .lean()
      .exec();

    expect(stored).toBeTruthy();
    expect(stored?.stateHash).toBe(stateHash);
    expect(stored?.stateHash).not.toBe(started.browserState);
    expect(stored?.nonceHash).toBe(digest(nonce as string));

    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain(started.browserState);
    expect(serialized).not.toContain(nonce as string);
  });

  it('consumes once and rejects replay', async () => {
    const started = await service.beginAuthorization();

    const consumed = await service.consumeAuthorization(
      started.browserState,
      started.browserState,
    );

    const url = new URL(started.authorizationUrl);

    expect(digest(consumed.codeVerifier)).toBe(
      url.searchParams.get('code_challenge'),
    );

    await expect(
      service.consumeAuthorization(started.browserState, started.browserState),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows exactly one concurrent consume winner', async () => {
    const started = await service.beginAuthorization();

    const results = await Promise.allSettled([
      service.consumeAuthorization(started.browserState, started.browserState),
      service.consumeAuthorization(started.browserState, started.browserState),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('rejects an expired transaction before TTL deletion', async () => {
    const started = await service.beginAuthorization();

    const stateHash = digest(started.browserState);

    await model.collection.updateOne(
      { stateHash },
      {
        $set: {
          expiresAt: new Date(Date.now() - 1_000),
        },
      },
    );

    await expect(
      model.countDocuments({
        stateHash,
      }),
    ).resolves.toBe(1);

    await expect(
      service.consumeAuthorization(started.browserState, started.browserState),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not consume for a wrong browser state', async () => {
    const started = await service.beginAuthorization();

    const stateHash = digest(started.browserState);

    await expect(
      service.consumeAuthorization(started.browserState, 'x'.repeat(43)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const stored = await model.findOne({ stateHash }).lean().exec();

    expect(stored?.consumedAt).toBeNull();
  });

  it('fails closed after an authentication-tag tamper', async () => {
    const started = await service.beginAuthorization();

    const stateHash = digest(started.browserState);

    const stored = await model
      .findOne({ stateHash })
      .select('+codeVerifierAuthTag')
      .lean()
      .exec();

    expect(stored).toBeTruthy();

    const currentTag = stored?.codeVerifierAuthTag ?? '';

    const replacement = currentTag.startsWith('A')
      ? `B${currentTag.slice(1)}`
      : `A${currentTag.slice(1)}`;

    await model.collection.updateOne(
      { stateHash },
      {
        $set: {
          codeVerifierAuthTag: replacement,
        },
      },
    );

    await expect(
      service.consumeAuthorization(started.browserState, started.browserState),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const consumed = await model.findOne({ stateHash }).lean().exec();

    expect(consumed?.consumedAt).toBeInstanceOf(Date);

    await expect(
      service.consumeAuthorization(started.browserState, started.browserState),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
