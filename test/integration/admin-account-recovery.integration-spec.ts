import { randomUUID } from 'node:crypto';
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
import * as bcrypt from 'bcrypt';
import { type Connection, type Model } from 'mongoose';
import { AdminModule } from '../../src/modules/admin/admin.module';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditSource,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import {
  ADMIN_RECOVERY_SECRET_STORE,
  type AdminRecoverySecretStore,
} from '../../src/modules/admin/interfaces/admin-account-recovery.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminRecoveryGrant } from '../../src/modules/admin/schemas/admin-recovery-grant.schema';
import { AdminReauthGrant } from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountRecoveryService } from '../../src/modules/admin/services/admin-account-recovery.service';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminCredentialService } from '../../src/modules/admin/services/admin-credential.service';
import { AdminMfaCryptoService } from '../../src/modules/admin/services/admin-mfa-crypto.service';
import { AdminReauthService } from '../../src/modules/admin/services/admin-reauth.service';
import { createAdminTotp } from '../../src/modules/admin/utils/admin-totp';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_recovery_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);
const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 1).toString('base64'),
      },
      previous: [],
    }),
  ]),
) as Readonly<Record<string, string>>;
const TEST_SECRETS = createAdminSecrets({
  source: { get: (key: string): unknown => SECRET_VALUES[key] },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});

class NoopRecoverySecretStore implements AdminRecoverySecretStore {
  assertReady(): void {}
  putVersion(): Promise<string> {
    return Promise.resolve('sm://integration/recovery/versions/1');
  }
  revokeVersion(): Promise<void> {
    return Promise.resolve();
  }
}

jest.setTimeout(90_000);

describe('Admin account recovery MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let recoveryGrants: Model<AdminRecoveryGrant>;
  let reauthGrants: Model<AdminReauthGrant>;
  let credentials: AdminCredentialService;
  let recovery: AdminAccountRecoveryService;
  let reauth: AdminReauthService;
  let crypto: AdminMfaCryptoService;
  let audit: AdminAuditService;

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
      .useValue(TEST_SECRETS)
      .overrideProvider(ADMIN_RECOVERY_SECRET_STORE)
      .useValue(new NoopRecoverySecretStore())
      .compile();
    connection = moduleRef.get(getConnectionToken());
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    sessions = moduleRef.get(getModelToken(AdminSession.name));
    recoveryGrants = moduleRef.get(getModelToken(AdminRecoveryGrant.name));
    reauthGrants = moduleRef.get(getModelToken(AdminReauthGrant.name));
    credentials = moduleRef.get(AdminCredentialService);
    recovery = moduleRef.get(AdminAccountRecoveryService);
    reauth = moduleRef.get(AdminReauthService);
    crypto = moduleRef.get(AdminMfaCryptoService);
    audit = moduleRef.get(AdminAuditService);
    await Promise.all([
      accounts.syncIndexes(),
      sessions.syncIndexes(),
      recoveryGrants.syncIndexes(),
      reauthGrants.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      accounts.deleteMany({}),
      sessions.deleteMany({}),
      recoveryGrants.deleteMany({}),
      reauthGrants.deleteMany({}),
      connection.collection('admin_audit_events').deleteMany({}),
      connection.collection('admin_login_protection').deleteMany({}),
    ]);
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

  const fixture = async () => {
    const secret = Buffer.alloc(20, 9);
    const password = 'Current#Password9';
    const recoveryCode = 'RECOVERY-CODE-0001';
    const account = await accounts.create({
      email: 'recovery@betta.test',
      username: 'admin.recovery',
      displayName: 'Admin Recovery',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: await bcrypt.hash(password, 4),
      mustChangePassword: false,
      credentialVersion: 2,
      authzVersion: 1,
      permissionVersion: 1,
      version: 3,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: crypto.encryptTotpSecret(secret, 'placeholder'),
      recoveryCodeHashes: [crypto.hashRecoveryCode(recoveryCode)],
      activationGrantConsumedAt: new Date(),
      lockedAt: null,
      deletedAt: null,
    });
    const encryptedTotpSecret = crypto.encryptTotpSecret(
      secret,
      account.publicId,
    );
    await accounts.updateOne(
      { _id: account._id },
      { $set: { encryptedTotpSecret } },
    );
    const session = await sessions.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${'a'.repeat(64)}`,
      deviceLabel: 'Integration Browser',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      revokeReason: null,
    });
    const actor = {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      permissionVersion: account.permissionVersion,
    } as const;
    return { account, session, secret, password, recoveryCode, actor };
  };

  it('creates unique hash and absolute TTL indexes', async () => {
    const recoveryIndexes = await recoveryGrants.collection.indexes();
    const reauthIndexes = await reauthGrants.collection.indexes();
    expect(
      recoveryIndexes.some(
        (index) => index.unique && index.key.grantHash === 1,
      ),
    ).toBe(true);
    expect(
      recoveryIndexes.some(
        (index) => index.expireAfterSeconds === 0 && index.key.expiresAt === 1,
      ),
    ).toBe(true);
    expect(
      reauthIndexes.some((index) => index.unique && index.key.grantHash === 1),
    ).toBe(true);
    expect(
      reauthIndexes.some(
        (index) => index.expireAfterSeconds === 0 && index.key.expiresAt === 1,
      ),
    ).toBe(true);
  });

  it('uses one recovery code, revokes sessions and confirms MFA exactly once', async () => {
    const value = await fixture();
    const challenge = await credentials.beginRecoveryCodeEnrollment({
      adminAccountId: value.account._id,
      adminPublicId: value.account.publicId,
      password: value.password,
      recoveryCode: value.recoveryCode,
      accountLabel: value.account.email,
      trustedClientIp: '203.0.113.20',
      source: AdminAuditSource.HTTP,
    });
    const pending = await accounts
      .findById(value.account._id)
      .select('+pendingEncryptedTotpSecret')
      .lean<Pick<AdminAccount, 'pendingEncryptedTotpSecret'>>()
      .exec();
    if (!pending?.pendingEncryptedTotpSecret)
      throw new Error('Thiếu pending MFA');
    const pendingSecret = crypto.decryptTotpSecret(
      pending.pendingEncryptedTotpSecret,
      value.account.publicId,
    );
    const token = createAdminTotp(
      pendingSecret,
      Math.floor(Date.now() / 30_000),
      6,
    );
    const codes = await recovery.confirmEnrollment({
      targetAdminPublicId: value.account.publicId,
      rawGrant: challenge.confirmationGrant,
      token,
      trustedClientIp: '203.0.113.20',
      source: AdminAuditSource.HTTP,
    });
    expect(codes).toHaveLength(10);
    await expect(
      recovery.confirmEnrollment({
        targetAdminPublicId: value.account.publicId,
        rawGrant: challenge.confirmationGrant,
        token,
        trustedClientIp: '203.0.113.20',
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await sessions.findById(value.session._id).lean()).toMatchObject({
      revokedAt: expect.any(Date),
    });
    const storedGrant = await recoveryGrants
      .findOne({ targetAdminPublicId: value.account.publicId })
      .select('+grantHash +secretReference')
      .lean()
      .exec();
    expect(storedGrant).toMatchObject({ consumedAt: expect.any(Date) });
    expect(JSON.stringify(storedGrant)).not.toContain(
      challenge.confirmationGrant,
    );
  });

  it('binds re-auth grants and allows exactly one concurrent consumer', async () => {
    const value = await fixture();
    const targetPublicId = 'adm_ABCDEFGHJKLM';
    const issueStartedAt = Date.now();
    const issued = await reauth.issue({
      adminAccountId: value.account._id,
      adminPublicId: value.account.publicId,
      sessionPublicId: value.session.publicId,
      password: value.password,
      totpToken: createAdminTotp(
        value.secret,
        Math.floor(Date.now() / 30_000),
        6,
      ),
      purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
      targetPublicId,
      trustedClientIp: '203.0.113.20',
      actor: value.actor,
      source: AdminAuditSource.HTTP,
    });

    const issueCompletedAt = Date.now();
    const expectedGrantTtlMs = 300_000;
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(
      issueStartedAt + expectedGrantTtlMs,
    );
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(
      issueCompletedAt + expectedGrantTtlMs,
    );

    const stored = await reauthGrants
      .findOne({ adminPublicId: value.account.publicId })
      .select('+credentialVersion +authzVersion +permissionVersion')
      .lean<
        Pick<
          AdminReauthGrant,
          | 'credentialVersion'
          | 'authzVersion'
          | 'permissionVersion'
          | 'purpose'
          | 'targetPublicId'
          | 'consumedAt'
        >
      >()
      .exec();
    expect(stored).toMatchObject({
      credentialVersion: value.account.credentialVersion,
      authzVersion: value.account.authzVersion,
      permissionVersion: value.account.permissionVersion,
      purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
      targetPublicId,
      consumedAt: null,
    });

    const consume = (
      overrides: Partial<{
        credentialVersion: number;
        authzVersion: number;
        permissionVersion: number;
        purpose: AdminReauthPurpose;
        targetPublicId: string;
      }> = {},
    ) =>
      connection.transaction((mongoSession) =>
        reauth.consumeInTransaction({
          rawGrant: issued.grant,
          adminAccountId: value.account._id,
          adminPublicId: value.account.publicId,
          sessionPublicId: value.session.publicId,
          credentialVersion: value.account.credentialVersion,
          authzVersion: value.account.authzVersion,
          permissionVersion: value.account.permissionVersion,
          purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
          targetPublicId,
          actor: value.actor,
          source: AdminAuditSource.HTTP,
          mongoSession,
          ...overrides,
        }),
      );

    await expect(
      consume({ purpose: AdminReauthPurpose.ADMINS_CREATE }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      consume({ targetPublicId: 'adm_ZYXWVUTSRQPN' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      consume({ credentialVersion: value.account.credentialVersion + 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      consume({ authzVersion: value.account.authzVersion + 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      consume({ permissionVersion: value.account.permissionVersion + 1 }),
    ).rejects.toMatchObject({ status: 401 });

    expect(
      await reauthGrants.countDocuments({ consumedAt: { $ne: null } }),
    ).toBe(0);

    const outcomes = await Promise.allSettled([consume(), consume()]);
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await connection
        .collection('admin_audit_events')
        .countDocuments({ action: AdminAuditAction.REAUTH_GRANT_CONSUMED }),
    ).toBe(1);
    await expect(consume()).rejects.toMatchObject({ status: 401 });
  });

  it('rolls back password, TOTP replay state and session revocation when audit fails', async () => {
    const value = await fixture();
    const token = createAdminTotp(
      value.secret,
      Math.floor(Date.now() / 30_000),
      6,
    );
    const failure = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('simulated audit outage'));
    await expect(
      credentials.changePassword({
        adminAccountId: value.account._id,
        adminPublicId: value.account.publicId,
        currentPassword: value.password,
        newPassword: 'Next#Password10',
        totpToken: token,
        trustedClientIp: '203.0.113.20',
        actor: value.actor,
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toThrow('simulated audit outage');
    failure.mockRestore();

    const stored = await accounts
      .findById(value.account._id)
      .select('+passwordHash +totpLastUsedStep +credentialVersion')
      .lean<
        Pick<
          AdminAccount,
          'passwordHash' | 'totpLastUsedStep' | 'credentialVersion'
        >
      >()
      .exec();
    expect(
      stored?.passwordHash &&
        (await bcrypt.compare(value.password, stored.passwordHash)),
    ).toBe(true);
    expect(stored?.credentialVersion).toBe(2);
    expect(stored?.totpLastUsedStep ?? null).toBeNull();
    expect(await sessions.findById(value.session._id).lean()).toMatchObject({
      revokedAt: null,
    });
  });
});
