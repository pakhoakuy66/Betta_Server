import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, type Model } from 'mongoose';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { createAdminPolicy } from '../../src/modules/admin/config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecretKey,
  type AdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import {
  ADMIN_LOGIN_PROTECTION_KEY_INDEX,
  ADMIN_LOGIN_PROTECTION_TTL_INDEX,
  AdminLoginProtectionScope,
} from '../../src/modules/admin/constants/admin-login-protection.constants';
import { AdminLoginProtection } from '../../src/modules/admin/schemas/admin-login-protection.schema';
import { AdminLoginProtectionService } from '../../src/modules/admin/services/admin-login-protection.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_login_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const policy = createAdminPolicy({ get: () => undefined });
const currentKey = Object.freeze({
  id: 'integration-lookup-v2',
  key: Buffer.alloc(32, 22),
});
const previousKey = Object.freeze({
  id: 'integration-lookup-v1',
  key: Buffer.alloc(32, 11),
});

const createSecrets = (
  current: AdminSecretKey,
  previous: readonly AdminSecretKey[] = [],
): AdminSecrets => ({
  current: (purpose) => {
    if (purpose !== AdminSecretPurpose.CONTACT_LOOKUP_HMAC) {
      throw new Error('Unexpected secret purpose');
    }
    return current;
  },
  resolve: (purpose, keyId) => {
    if (purpose !== AdminSecretPurpose.CONTACT_LOOKUP_HMAC) {
      throw new Error('Unexpected secret purpose');
    }
    const resolved = [current, ...previous].find((key) => key.id === keyId);
    if (!resolved) throw new Error('Unknown integration key');
    return resolved;
  },
  candidates: () => [current, ...previous],
  describe: () => [],
  toJSON: () => ({ redacted: true, keyrings: [] }),
});

const getRateLimitResponse = (error: unknown): Record<string, unknown> => {
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(429);
  const response = exception.getResponse();
  expect(response).toEqual(
    expect.objectContaining({
      statusCode: 429,
      message: 'Không thể đăng nhập lúc này. Vui lòng thử lại sau.',
      retryAfterSeconds: expect.any(Number),
    }),
  );
  return response as Record<string, unknown>;
};

jest.setTimeout(90_000);

describe('Admin login protection MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let model: Model<AdminLoginProtection>;
  let service: AdminLoginProtectionService;

  const recordFailuresBeforeLock = async (
    accountKey: string,
    trustedClientIp: string,
  ): Promise<void> => {
    for (
      let index = 1;
      index < policy.loginProtection.maxFailedAttempts;
      index += 1
    ) {
      await service.recordFailure({ accountKey, trustedClientIp });
    }
  };

  const triggerAccountLock = async (
    accountKey: string,
    trustedClientIp: string,
  ): Promise<Record<string, unknown>> => {
    await recordFailuresBeforeLock(accountKey, trustedClientIp);
    let error: unknown;
    try {
      await service.recordFailure({ accountKey, trustedClientIp });
    } catch (caught: unknown) {
      error = caught;
    }
    return getRateLimitResponse(error);
  };

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI không được trùng runtime URI');
    }
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Tên integration database không an toàn');
    }

    const testSecrets = createSecrets(currentKey, [previousKey]);
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        AdminModule,
      ],
    })
      .overrideProvider(ADMIN_SECRETS)
      .useValue(testSecrets)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    model = moduleRef.get<Model<AdminLoginProtection>>(
      getModelToken(AdminLoginProtection.name),
    );
    await model.syncIndexes();
    service = moduleRef.get(AdminLoginProtectionService);
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Từ chối xóa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  it('resolves the model and service through AdminModule dependency injection', () => {
    expect(model).toBeDefined();
    expect(service).toBeInstanceOf(AdminLoginProtectionService);
  });

  it('creates the unique privacy key and absolute TTL indexes', async () => {
    const indexes = await model.collection.indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get(ADMIN_LOGIN_PROTECTION_KEY_INDEX)).toEqual(
      expect.objectContaining({
        key: { scope: 1, keyLocators: 1 },
        unique: true,
      }),
    );
    expect(byName.get(ADMIN_LOGIN_PROTECTION_TTL_INDEX)).toEqual(
      expect.objectContaining({
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
      }),
    );
  });

  it('gives existing-looking and unknown accounts the same generic lock response', async () => {
    const existing = await triggerAccountLock(
      'known-admin@example.com',
      '203.0.113.10',
    );
    const unknown = await triggerAccountLock(
      'unknown-admin@example.com',
      '203.0.113.11',
    );

    expect(unknown.message).toBe(existing.message);
    expect(unknown.statusCode).toBe(existing.statusCode);
    expect(typeof existing.retryAfterSeconds).toBe('number');
    expect(typeof unknown.retryAfterSeconds).toBe('number');
  });

  it('allows moderate failures from multiple accounts behind one shared IP', async () => {
    const sharedIp = '198.51.100.20';

    for (let account = 0; account < 4; account += 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await service.recordFailure({
          accountKey: `shared-${account}@example.com`,
          trustedClientIp: sharedIp,
        });
      }
    }

    await expect(
      service.assertAllowed({
        accountKey: 'another-admin@example.com',
        trustedClientIp: sharedIp,
      }),
    ).resolves.toBeUndefined();
  });

  it('throttles account spraying by trusted IP without storing raw identifiers', async () => {
    const trustedClientIp = '198.51.100.30';

    for (let attempt = 0; attempt < 19; attempt += 1) {
      await service.recordFailure({
        accountKey: `spray-${attempt}@example.com`,
        trustedClientIp,
      });
    }

    await expect(
      service.recordFailure({
        accountKey: 'spray-19@example.com',
        trustedClientIp,
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.assertAllowed({
        accountKey: 'fresh-admin@example.com',
        trustedClientIp,
      }),
    ).rejects.toBeInstanceOf(HttpException);

    const serialized = JSON.stringify(await model.find({}).lean().exec());
    expect(serialized).not.toContain(trustedClientIp);
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain('credential');
  });

  it('has one atomic concurrent winner and never extends an active lock', async () => {
    const identity = {
      accountKey: 'concurrent@example.com',
      trustedClientIp: '203.0.113.40',
    };
    const results = await Promise.allSettled(
      Array.from(
        { length: policy.loginProtection.maxFailedAttempts },
        async () => service.recordFailure(identity),
      ),
    );

    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    const locked = await model
      .findOne({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection | null>()
      .exec();
    expect(locked?.failedAttempts).toBe(
      policy.loginProtection.maxFailedAttempts,
    );
    expect(locked?.lockedUntil).toBeInstanceOf(Date);
    const originalLockedUntil = locked?.lockedUntil?.getTime();

    await expect(service.recordFailure(identity)).rejects.toBeInstanceOf(
      HttpException,
    );
    const repeated = await model
      .findOne({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection | null>()
      .exec();
    expect(repeated?.failedAttempts).toBe(locked?.failedAttempts);
    expect(repeated?.lockedUntil?.getTime()).toBe(originalLockedUntil);
  });

  it('unlocks logically, starts a fresh window and clears only account state on success', async () => {
    const identity = {
      accountKey: 'unlock@example.com',
      trustedClientIp: '203.0.113.50',
    };
    await triggerAccountLock(identity.accountKey, identity.trustedClientIp);
    const past = new Date(Date.now() - 1_000);

    await model.updateOne(
      { scope: AdminLoginProtectionScope.ACCOUNT },
      { $set: { lockedUntil: past, expiresAt: past } },
    );
    await expect(service.assertAllowed(identity)).resolves.toBeUndefined();
    await expect(service.recordFailure(identity)).resolves.toBeUndefined();

    const reset = await model
      .findOne({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection | null>()
      .exec();
    expect(reset?.failedAttempts).toBe(1);
    expect(reset?.lockedUntil).toBeNull();
    expect(reset?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await service.clearAccountFailures(identity.accountKey);
    expect(
      await model.countDocuments({
        scope: AdminLoginProtectionScope.ACCOUNT,
      }),
    ).toBe(0);
    expect(
      await model.countDocuments({ scope: AdminLoginProtectionScope.IP }),
    ).toBe(1);
  });

  it('resets an expired pre-lock failure window without locking the account', async () => {
    const identity = {
      accountKey: 'expired-window@example.com',
      trustedClientIp: '203.0.113.55',
    };
    await recordFailuresBeforeLock(
      identity.accountKey,
      identity.trustedClientIp,
    );

    const staleWindowStartedAt = new Date(
      Date.now() - (policy.loginProtection.failureWindowSeconds + 30) * 1_000,
    );
    const staleExpiresAt = new Date(Date.now() - 1_000);
    await model.updateOne(
      { scope: AdminLoginProtectionScope.ACCOUNT },
      {
        $set: {
          windowStartedAt: staleWindowStartedAt,
          lockedUntil: null,
          expiresAt: staleExpiresAt,
        },
      },
    );

    await expect(service.recordFailure(identity)).resolves.toBeUndefined();

    const reset = await model
      .findOne({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection | null>()
      .exec();
    expect(reset?.failedAttempts).toBe(1);
    expect(reset?.lockedUntil).toBeNull();
    expect(reset?.windowStartedAt.getTime()).toBeGreaterThan(
      staleWindowStartedAt.getTime(),
    );
    expect(reset?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps one logical counter when old and new HMAC key instances write concurrently', async () => {
    const oldService = new AdminLoginProtectionService(
      model,
      connection,
      createSecrets(previousKey),
      policy,
    );
    const identity = {
      accountKey: 'rolling-race@example.com',
      trustedClientIp: '203.0.113.60',
    };
    const results = await Promise.allSettled(
      Array.from(
        { length: policy.loginProtection.maxFailedAttempts },
        async (_unused, index) =>
          (index % 2 === 0 ? oldService : service).recordFailure(identity),
      ),
    );

    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    const accountRecords = await model
      .find({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection[]>()
      .exec();
    expect(accountRecords).toHaveLength(1);
    expect(accountRecords[0]?.keyLocators).toEqual(
      expect.arrayContaining([
        expect.stringMatching(`^${previousKey.id}:`),
        expect.stringMatching(`^${currentKey.id}:`),
      ]),
    );
    expect(accountRecords[0]?.failedAttempts).toBe(
      policy.loginProtection.maxFailedAttempts,
    );
    expect(accountRecords[0]?.lockedUntil).toBeInstanceOf(Date);
  });

  it('converges split key-rotation counters before enforcing the threshold', async () => {
    const oldService = new AdminLoginProtectionService(
      model,
      connection,
      createSecrets(previousKey),
      policy,
    );
    const currentOnlyService = new AdminLoginProtectionService(
      model,
      connection,
      createSecrets(currentKey),
      policy,
    );
    const identity = {
      accountKey: 'split-counter@example.com',
      trustedClientIp: '203.0.113.61',
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await oldService.recordFailure(identity);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await currentOnlyService.recordFailure(identity);
    }
    expect(
      await model.countDocuments({
        scope: AdminLoginProtectionScope.ACCOUNT,
      }),
    ).toBe(2);

    await expect(service.recordFailure(identity)).rejects.toBeInstanceOf(
      HttpException,
    );

    const accountRecords = await model
      .find({ scope: AdminLoginProtectionScope.ACCOUNT })
      .lean<AdminLoginProtection[]>()
      .exec();
    expect(accountRecords).toHaveLength(1);
    expect(accountRecords[0]?.keyLocators).toEqual(
      expect.arrayContaining([
        expect.stringMatching(`^${previousKey.id}:`),
        expect.stringMatching(`^${currentKey.id}:`),
      ]),
    );
    expect(accountRecords[0]?.failedAttempts).toBe(
      policy.loginProtection.maxFailedAttempts,
    );

    await expect(
      currentOnlyService.assertAllowed(identity),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
