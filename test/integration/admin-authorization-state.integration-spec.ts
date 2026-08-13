import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
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
import {
  AdminAccount,
  AdminAccountSchema,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/schemas/admin-account.schema';
import {
  AdminSession,
  AdminSessionSchema,
} from '../../src/modules/admin/schemas/admin-session.schema';
import { ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS } from '../../src/modules/admin/constants/admin-authorization-state.constants';
import { ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE } from '../../src/modules/admin/constants/admin-auth-token.constants';
import { AdminAuthorizationStateService } from '../../src/modules/admin/services/admin-authorization-state.service';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_admin_authz_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

jest.setTimeout(90_000);

describe('Admin authorization state MongoDB integration', () => {
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let sessionModel: Model<AdminSession>;
  let nowMs = Date.now();

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

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();
    accountModel = connection.model(
      AdminAccount.name,
      AdminAccountSchema.clone(),
    );
    sessionModel = connection.model(
      AdminSession.name,
      AdminSessionSchema.clone(),
    );
    await Promise.all([accountModel.syncIndexes(), sessionModel.syncIndexes()]);
  });

  beforeEach(async () => {
    nowMs = Date.now();
    await Promise.all([
      accountModel.deleteMany({}),
      sessionModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Từ chối xóa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  const createFixture = async (suffix: string) => {
    const account = await accountModel.create({
      email: `${suffix}@betta.test`,
      username: suffix,
      displayName: `Admin ${suffix}`,
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: 'x'.repeat(32),
      mustChangePassword: false,
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'encrypted-totp-secret',
      recoveryCodeHashes: [],
      activationGrantConsumedAt: new Date(nowMs - 1_000),
      lockedAt: null,
      deletedAt: null,
    });
    const session = await sessionModel.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${'a'.repeat(64)}`,
      deviceLabel: 'Integration Browser',
      lastUsedAt: new Date(nowMs),
      expiresAt: new Date(nowMs + 60_000),
      revokedAt: null,
      revokeReason: null,
    });
    const input = {
      adminPublicId: account.publicId,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
    };
    return { account, session, input };
  };

  const createService = (): AdminAuthorizationStateService =>
    new AdminAuthorizationStateService(accountModel, sessionModel, () => nowMs);

  it('resolves only an active account bound to an active shared session', async () => {
    const fixture = await createFixture('shared');
    const principal = await createService().resolvePrincipal(fixture.input);

    expect(principal).toMatchObject({
      publicId: fixture.account.publicId,
      sessionId: fixture.session.publicId,
      authzVersion: 1,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(JSON.stringify(principal)).not.toMatch(
      /password|refresh|tokenFamily|recovery|totp/i,
    );
  });

  it('converges two independent instance caches within the SRS five-second bound', async () => {
    const fixture = await createFixture('multi-instance');
    const instanceA = createService();
    const instanceB = createService();

    await Promise.all([
      instanceA.resolvePrincipal(fixture.input),
      instanceB.resolvePrincipal(fixture.input),
    ]);
    await accountModel.updateOne(
      { _id: fixture.account._id, authzVersion: 1 },
      { $set: { authzVersion: 2 } },
    );

    await expect(
      instanceA.resolvePrincipal(fixture.input),
    ).resolves.not.toBeNull();
    await expect(
      instanceB.resolvePrincipal(fixture.input),
    ).resolves.not.toBeNull();

    expect(ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS).toBeLessThan(5_000);
    nowMs += ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS + 1;

    await expect(instanceA.resolvePrincipal(fixture.input)).resolves.toBeNull();
    await expect(instanceB.resolvePrincipal(fixture.input)).resolves.toBeNull();
    await expect(
      instanceA.resolvePrincipal({ ...fixture.input, authzVersion: 2 }),
    ).resolves.not.toBeNull();
  });

  it('observes session revocation on every instance without waiting for account cache', async () => {
    const fixture = await createFixture('revoke');
    const instanceA = createService();
    const instanceB = createService();
    await Promise.all([
      instanceA.resolvePrincipal(fixture.input),
      instanceB.resolvePrincipal(fixture.input),
    ]);

    await sessionModel.updateOne(
      { _id: fixture.session._id, revokedAt: null },
      { $set: { revokedAt: new Date(nowMs), revokeReason: 'logout_all' } },
    );

    await expect(instanceA.resolvePrincipal(fixture.input)).resolves.toBeNull();
    await expect(instanceB.resolvePrincipal(fixture.input)).resolves.toBeNull();
  });

  it('fails closed with sanitized 503 when an expired cache cannot reach the authoritative store', async () => {
    const fixture = await createFixture('outage');
    const service = createService();
    await expect(
      service.resolvePrincipal(fixture.input),
    ).resolves.not.toBeNull();

    nowMs += ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS + 1;
    const outage = Object.assign(new Error('raw topology details'), {
      name: 'MongoServerSelectionError',
    });
    const findOneSpy = jest
      .spyOn(accountModel, 'findOne')
      .mockImplementationOnce(() => {
        throw outage;
      });

    try {
      const result = service.resolvePrincipal(fixture.input);
      await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(result).rejects.toMatchObject({
        response: {
          statusCode: 503,
          message: ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
        },
      });
      await expect(result).rejects.not.toThrow('raw topology details');
    } finally {
      findOneSpy.mockRestore();
    }
  });
});
