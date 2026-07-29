import { createHash, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
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
import { createConnection, type Connection, type Model } from 'mongoose';

import { GoogleOAuthSessionHandoffInvalidException } from '../../src/modules/auth/exceptions/google-oauth-session-handoff-invalid.exception';
import type { AuthResponse } from '../../src/modules/auth/interfaces/auth.interface';
import type { IssuedGoogleOAuthSessionHandoff } from '../../src/modules/auth/interfaces/google-oauth-session-handoff.interface';
import {
  GoogleOAuthSessionHandoff,
  GoogleOAuthSessionHandoffSchema,
} from '../../src/modules/auth/schemas/google-oauth-session-handoff.schema';
import { GoogleOAuthSessionHandoffService } from '../../src/modules/auth/services/google-oauth-session-handoff.service';
import { GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX } from '../../src/modules/auth/constants/google-oauth-session-handoff.constants';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_handoff_it_';
const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const AUTH_RESPONSE: AuthResponse = {
  message: 'Đăng nhập bằng Google thành công',
  access_token: 'integration-access-token-secret',
  refresh_token: 'integration-refresh-token-secret',
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

jest.setTimeout(90_000);

describe('Google OAuth session handoff lifecycle integration', () => {
  let connection: Connection;
  let handoffModel: Model<GoogleOAuthSessionHandoff>;
  let service: GoogleOAuthSessionHandoffService;

  const hash = (rawHandoff: string): string =>
    createHash('sha256').update(rawHandoff, 'utf8').digest('base64url');

  const issue = async (): Promise<IssuedGoogleOAuthSessionHandoff> => {
    let result: IssuedGoogleOAuthSessionHandoff | undefined;

    await connection.transaction(async (mongoSession) => {
      result = await service.issue(AUTH_RESPONSE, mongoSession);
    });

    if (!result) {
      throw new Error('Expected issued handoff');
    }

    return result;
  };

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }

    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES
    ) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    handoffModel = connection.model<GoogleOAuthSessionHandoff>(
      'GoogleOAuthSessionHandoffLifecycleIntegration',
      GoogleOAuthSessionHandoffSchema.clone(),
    );

    await handoffModel.syncIndexes();

    const values: Record<string, string> = {
      GOOGLE_OAUTH_ENABLED: 'true',
      GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64: Buffer.alloc(32, 11).toString(
        'base64',
      ),
      GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS: '120',
      GOOGLE_OAUTH_TRANSACTION_KEY_BASE64: Buffer.alloc(32, 12).toString(
        'base64',
      ),
      JWT_SECRET: 'integration-access-secret-different-from-handoff',
      JWT_REFRESH_SECRET: 'integration-refresh-secret-different-from-handoff',
    };

    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    service = new GoogleOAuthSessionHandoffService(handoffModel, configService);
  });

  beforeEach(async () => {
    await handoffModel.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    try {
      if (
        !connection.name.startsWith(DATABASE_PREFIX) ||
        Buffer.byteLength(connection.name, 'utf8') > MAX_DATABASE_NAME_BYTES
      ) {
        throw new Error(
          `Từ chối xóa database không an toàn: ${connection.name}`,
        );
      }

      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('stores encrypted data and consumes the public response once', async () => {
    const issued = await issue();
    const rawDocument = await handoffModel.collection.findOne({
      handoffHash: hash(issued.rawHandoff),
    });

    expect(rawDocument).not.toBeNull();

    const serializedStorage = JSON.stringify(rawDocument);

    expect(serializedStorage).not.toContain(issued.rawHandoff);
    expect(serializedStorage).not.toContain(AUTH_RESPONSE.access_token);
    expect(serializedStorage).not.toContain(AUTH_RESPONSE.refresh_token);

    await expect(service.consume(issued.rawHandoff)).resolves.toEqual(
      AUTH_RESPONSE,
    );

    await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
      GoogleOAuthSessionHandoffInvalidException,
    );
  });

  it('allows only one concurrent consume winner', async () => {
    const issued = await issue();
    const results = await Promise.allSettled([
      service.consume(issued.rawHandoff),
      service.consume(issued.rawHandoff),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    const rejected = results.find((result) => result.status === 'rejected');

    expect(rejected).toBeDefined();

    if (!rejected || rejected.status !== 'rejected') {
      throw new Error('Expected one rejected consume');
    }

    expect(rejected.reason).toBeInstanceOf(
      GoogleOAuthSessionHandoffInvalidException,
    );
  });

  it('rejects an expired document before TTL cleanup', async () => {
    await handoffModel.collection.dropIndex(
      GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
    );

    try {
      const issued = await issue();

      const updateResult = await handoffModel.collection.updateOne(
        {
          handoffHash: hash(issued.rawHandoff),
        },
        {
          $set: {
            expiresAt: new Date(Date.now() - 1_000),
          },
        },
      );

      expect(updateResult.modifiedCount).toBe(1);

      await expect(handoffModel.countDocuments({})).resolves.toBe(1);

      await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
        GoogleOAuthSessionHandoffInvalidException,
      );

      await expect(handoffModel.countDocuments({})).resolves.toBe(1);
    } finally {
      await handoffModel.syncIndexes();
    }
  });

  it('fails closed when the authentication tag is corrupted', async () => {
    const issued = await issue();

    await handoffModel.collection.updateOne(
      {
        handoffHash: hash(issued.rawHandoff),
      },
      {
        $set: {
          payloadAuthTag: 'A'.repeat(22),
        },
      },
    );

    await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
      GoogleOAuthSessionHandoffInvalidException,
    );
  });

  it('binds expiresAt into AAD and fails closed after tampering', async () => {
    const issued = await issue();
    const updateResult = await handoffModel.collection.updateOne(
      {
        handoffHash: hash(issued.rawHandoff),
      },
      {
        $set: {
          expiresAt: new Date(issued.expiresAt.getTime() + 60_000),
        },
      },
    );

    expect(updateResult.modifiedCount).toBe(1);

    await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await expect(service.consume(issued.rawHandoff)).rejects.toBeInstanceOf(
      GoogleOAuthSessionHandoffInvalidException,
    );
  });
});
