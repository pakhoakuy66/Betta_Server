import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
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
import { createAdminPolicy } from '../../src/modules/admin/config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import { ADMIN_REFRESH_TOKEN_INVALID_MESSAGE } from '../../src/modules/admin/constants/admin-auth-token.constants';
import { AdminAuditAction } from '../../src/modules/admin/constants/admin-audit.constants';
import { type AdminSessionAccount } from '../../src/modules/admin/interfaces/admin-session.interface';
import {
  AdminAccount,
  AdminAccountSchema,
} from '../../src/modules/admin/schemas/admin-account.schema';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../../src/modules/admin/schemas/admin-audit-event.schema';
import {
  ADMIN_SESSION_FAMILY_INDEX,
  ADMIN_SESSION_OWNER_LIST_INDEX,
  ADMIN_SESSION_PUBLIC_ID_INDEX,
  ADMIN_SESSION_TTL_INDEX,
} from '../../src/modules/admin/constants/admin-session.constants';
import {
  AdminSession,
  AdminSessionSchema,
} from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminSessionService } from '../../src/modules/admin/services/admin-session.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_admin_session_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

jest.setTimeout(90_000);

describe('Admin session store MongoDB integration', () => {
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let auditModel: Model<AdminAuditEvent>;
  let sessionModel: Model<AdminSession>;
  let auditService: AdminAuditService;
  let service: AdminSessionService;

  const policy = createAdminPolicy({ get: () => undefined });
  const refreshKey = Object.freeze({
    id: 'integration-refresh-v1',
    key: Buffer.alloc(32, 9),
  });
  const secrets: AdminSecrets = {
    current: (purpose) => {
      if (purpose !== AdminSecretPurpose.REFRESH_TOKEN_SIGNING) {
        throw new Error('Unexpected secret purpose');
      }
      return refreshKey;
    },
    resolve: (purpose, keyId) => {
      if (
        purpose !== AdminSecretPurpose.REFRESH_TOKEN_SIGNING ||
        keyId !== refreshKey.id
      ) {
        throw new Error('Unknown refresh key');
      }
      return refreshKey;
    },
    candidates: () => [refreshKey],
    describe: () => [],
    toJSON: () => ({ redacted: true, keyrings: [] }),
  };

  const createAccount = async (
    suffix: string,
  ): Promise<AdminSessionAccount> => {
    const document = await accountModel.create({
      email: `${suffix}@example.com`,
      username: suffix,
      displayName: `Admin ${suffix}`,
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: 'x'.repeat(32),
      mustChangePassword: false,
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'encrypted-totp-secret',
      recoveryCodeHashes: [],
      activationGrantConsumedAt: new Date(),
      lockedAt: null,
      deletedAt: null,
    });

    return {
      _id: document._id,
      publicId: document.publicId,
      username: document.username,
      displayName: document.displayName,
      role: document.role,
      credentialVersion: document.credentialVersion,
      authzVersion: document.authzVersion,
      permissionVersion: document.permissionVersion,
    };
  };

  const createSession = async (account: AdminSessionAccount) =>
    connection.transaction((mongoSession) =>
      service.createSession(
        account,
        { userAgent: 'Mozilla Chrome/120 Windows' },
        mongoSession,
      ),
    );

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
    auditModel = connection.model(
      AdminAuditEvent.name,
      AdminAuditEventSchema.clone(),
    );
    sessionModel = connection.model(
      AdminSession.name,
      AdminSessionSchema.clone(),
    );
    await Promise.all([
      accountModel.syncIndexes(),
      auditModel.syncIndexes(),
      sessionModel.syncIndexes(),
    ]);
    auditService = new AdminAuditService(auditModel, policy);
    service = new AdminSessionService(
      sessionModel,
      accountModel,
      new JwtService(),
      secrets,
      policy,
      connection,
      auditService,
    );
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
      accountModel.deleteMany({}),
      auditModel.collection.deleteMany({}),
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

  it('creates unique, TTL and owner-list indexes', async () => {
    const indexes = (await sessionModel.collection
      .listIndexes()
      .toArray()) as Array<{
      name?: string;
      expireAfterSeconds?: number;
    }>;
    const names = new Set(indexes.map((index) => index.name));
    expect(names.has(ADMIN_SESSION_PUBLIC_ID_INDEX)).toBe(true);
    expect(names.has(ADMIN_SESSION_FAMILY_INDEX)).toBe(true);
    expect(names.has(ADMIN_SESSION_TTL_INDEX)).toBe(true);
    expect(names.has(ADMIN_SESSION_OWNER_LIST_INDEX)).toBe(true);
    expect(
      indexes.find((index) => index.name === ADMIN_SESSION_TTL_INDEX)
        ?.expireAfterSeconds,
    ).toBe(0);
  });

  it('creates and lists multiple independent sessions without secret leakage', async () => {
    const owner = await createAccount('owner');
    const first = await createSession(owner);
    await createSession(owner);

    const page = await service.listActiveSessions(
      owner._id,
      first.sessionPublicId,
      1,
      20,
    );
    expect(page.items).toHaveLength(2);
    expect(page.items.filter((item) => item.isCurrent)).toHaveLength(1);
    expect(page.pagination).toEqual({ page: 1, limit: 20, hasMore: false });
    expect(JSON.stringify(page)).not.toContain('refreshToken');
    expect(JSON.stringify(page)).not.toContain('tokenFamily');
    expect(JSON.stringify(page)).not.toContain(owner._id.toHexString());
  });

  it('rejects and hides logically expired sessions before TTL cleanup runs', async () => {
    const owner = await createAccount('expired');
    const credential = await createSession(owner);
    await sessionModel.updateOne(
      { publicId: credential.sessionPublicId },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
      { runValidators: true },
    );

    await expect(
      service.isSessionActive(owner._id, credential.sessionPublicId),
    ).resolves.toBe(false);
    await expect(
      service.listActiveSessions(owner._id, credential.sessionPublicId, 1, 20),
    ).resolves.toMatchObject({
      items: [],
      pagination: { page: 1, limit: 20, hasMore: false },
    });
    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow(ADMIN_REFRESH_TOKEN_INVALID_MESSAGE);
  });

  it('keeps the concurrent winner active and only revokes on sequential replay', async () => {
    const owner = await createAccount('rotate');
    const credential = await createSession(owner);

    const results = await Promise.allSettled([
      service.rotateRefreshToken(credential.refreshToken),
      service.rotateRefreshToken(credential.refreshToken),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const winner = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<AdminSessionService['rotateRefreshToken']>>
      > => result.status === 'fulfilled',
    );
    if (!winner) throw new Error('Concurrent rotation không có winner');

    await expect(
      service.isSessionActive(owner._id, credential.sessionPublicId),
    ).resolves.toBe(true);
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.SESSION_ROTATED,
      }),
    ).toBe(1);
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.REFRESH_REPLAY_DETECTED,
      }),
    ).toBe(0);

    await expect(
      service.rotateRefreshToken(winner.value.refreshToken),
    ).resolves.toMatchObject({ sessionPublicId: credential.sessionPublicId });

    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow(ADMIN_REFRESH_TOKEN_INVALID_MESSAGE);
    await expect(
      service.isSessionActive(owner._id, credential.sessionPublicId),
    ).resolves.toBe(false);
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.REFRESH_REPLAY_DETECTED,
      }),
    ).toBe(1);
  });

  it('rolls back rotation when atomic audit persistence fails', async () => {
    const owner = await createAccount('rotaudit');
    const credential = await createSession(owner);
    const auditSpy = jest
      .spyOn(auditService, 'record')
      .mockRejectedValue(new Error('injected rotation audit failure'));

    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow('injected rotation audit failure');
    auditSpy.mockRestore();

    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).resolves.toMatchObject({ sessionPublicId: credential.sessionPublicId });
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.SESSION_ROTATED,
      }),
    ).toBe(1);
  });

  it('rolls back replay revocation when its audit persistence fails', async () => {
    const owner = await createAccount('repaudit');
    const credential = await createSession(owner);
    await service.rotateRefreshToken(credential.refreshToken);
    const auditSpy = jest
      .spyOn(auditService, 'record')
      .mockRejectedValue(new Error('injected replay audit failure'));

    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow('injected replay audit failure');
    auditSpy.mockRestore();

    await expect(
      service.isSessionActive(owner._id, credential.sessionPublicId),
    ).resolves.toBe(true);
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.REFRESH_REPLAY_DETECTED,
      }),
    ).toBe(0);

    await expect(
      service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow(ADMIN_REFRESH_TOKEN_INVALID_MESSAGE);
    await expect(
      service.isSessionActive(owner._id, credential.sessionPublicId),
    ).resolves.toBe(false);
  });

  it('paginates with hasMore and no duplicate session IDs', async () => {
    const owner = await createAccount('paging');
    const current = await createSession(owner);
    await createSession(owner);
    await createSession(owner);

    const first = await service.listActiveSessions(
      owner._id,
      current.sessionPublicId,
      1,
      2,
    );
    const second = await service.listActiveSessions(
      owner._id,
      current.sessionPublicId,
      2,
      2,
    );
    const ids = [...first.items, ...second.items].map((item) => item.id);

    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });
    expect(second.pagination).toEqual({ page: 2, limit: 2, hasMore: false });
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects cross-account revoke without modifying the target session', async () => {
    const owner = await createAccount('ownerx');
    const other = await createAccount('otherx');
    const ownerCurrent = await createSession(owner);
    const otherSession = await createSession(other);

    await expect(
      service.revokeOtherSession(
        owner,
        ownerCurrent.sessionPublicId,
        otherSession.sessionPublicId,
      ),
    ).rejects.toThrow('Không tìm thấy phiên quản trị');
    await expect(
      service.isSessionActive(other._id, otherSession.sessionPublicId),
    ).resolves.toBe(true);
  });

  it('rolls back revoke when audit persistence fails', async () => {
    const owner = await createAccount('rollback');
    const current = await createSession(owner);
    const target = await createSession(owner);
    jest
      .spyOn(auditService, 'record')
      .mockRejectedValue(new Error('injected audit failure'));

    await expect(
      service.revokeOtherSession(
        owner,
        current.sessionPublicId,
        target.sessionPublicId,
      ),
    ).rejects.toThrow('injected audit failure');
    await expect(
      service.isSessionActive(owner._id, target.sessionPublicId),
    ).resolves.toBe(true);
  });

  it('revokes one owner session transactionally with its audit', async () => {
    const owner = await createAccount('revoke');
    const current = await createSession(owner);
    const target = await createSession(owner);

    await service.revokeOtherSession(
      owner,
      current.sessionPublicId,
      target.sessionPublicId,
    );

    await expect(
      service.isSessionActive(owner._id, target.sessionPublicId),
    ).resolves.toBe(false);
    expect(
      await auditModel.countDocuments({
        action: AdminAuditAction.SESSION_REVOKED,
        'target.publicId': target.sessionPublicId,
      }),
    ).toBe(1);
  });

  it('revokes all active sessions and records the affected count', async () => {
    const owner = await createAccount('allowner');
    await createSession(owner);
    await createSession(owner);
    await createSession(owner);

    await expect(service.logoutAllSelf(owner)).resolves.toBe(3);
    await expect(
      sessionModel.countDocuments({
        adminAccountId: owner._id,
        revokedAt: null,
      }),
    ).resolves.toBe(0);
    const audit = await auditModel.collection.findOne({
      action: AdminAuditAction.SESSIONS_REVOKED_ALL,
    });
    expect(audit?.metadata).toEqual(
      expect.objectContaining({ affectedSessionCount: 3 }),
    );
  });
});
