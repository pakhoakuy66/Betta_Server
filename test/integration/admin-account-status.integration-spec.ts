import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
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
import { type Connection, type Model, Types } from 'mongoose';
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
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../../src/modules/admin/constants/admin-session.constants';
import {
  type AdminAccountStatusActor,
  type UpdateAdminAccountStatusInput,
} from '../../src/modules/admin/interfaces/admin-account-status.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminLifecycleCoordinator } from '../../src/modules/admin/schemas/admin-lifecycle-coordinator.schema';
import { AdminReauthGrant } from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountStatusService } from '../../src/modules/admin/services/admin-account-status.service';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import {
  generateAdminSecurityGrant,
  hashAdminReauthGrant,
} from '../../src/modules/admin/utils/admin-security-grant';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_status_it_';
const MONGODB_DATABASE_NAME_MAX_BYTES = 38;
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 6);

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `status-integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 41).toString('base64'),
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

type FixtureAccount = Readonly<{
  account: AdminAccount & { _id: Types.ObjectId };
  session: AdminSession;
  actor: AdminAccountStatusActor;
}>;

jest.setTimeout(120_000);

describe('Admin account status MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let grants: Model<AdminReauthGrant>;
  let audits: Model<AdminAuditEvent>;
  let coordinators: Model<AdminLifecycleCoordinator>;
  let statuses: AdminAccountStatusService;
  let audit: AdminAuditService;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chua duoc cau hinh`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES la bat buoc`);
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI khong duoc trung runtime URI');
    }
    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > MONGODB_DATABASE_NAME_MAX_BYTES
    ) {
      throw new Error('Ten integration database khong an toan');
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
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    accounts = moduleRef.get<Model<AdminAccount>>(
      getModelToken(AdminAccount.name),
    );
    sessions = moduleRef.get<Model<AdminSession>>(
      getModelToken(AdminSession.name),
    );
    grants = moduleRef.get<Model<AdminReauthGrant>>(
      getModelToken(AdminReauthGrant.name),
    );
    audits = moduleRef.get<Model<AdminAuditEvent>>(
      getModelToken(AdminAuditEvent.name),
    );
    coordinators = moduleRef.get<Model<AdminLifecycleCoordinator>>(
      getModelToken(AdminLifecycleCoordinator.name),
    );
    statuses = moduleRef.get(AdminAccountStatusService);
    audit = moduleRef.get(AdminAuditService);
    await Promise.all([
      accounts.syncIndexes(),
      sessions.syncIndexes(),
      grants.syncIndexes(),
      audits.syncIndexes(),
      coordinators.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
      accounts.deleteMany({}),
      sessions.deleteMany({}),
      grants.deleteMany({}),
      coordinators.deleteMany({}),
      audits.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Tu choi xoa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const createEffectiveAccount = async (
    publicId: string,
    username: string,
    role: AdminRole,
    permission: AdminPermission,
  ): Promise<FixtureAccount> => {
    const account = await accounts.create({
      publicId,
      email: `${username}@betta.test`,
      username,
      displayName: username,
      role,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: `atotp_v1.integration.${publicId}`,
      activationGrantConsumedAt: new Date(),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      version: 0,
      lockedAt: null,
      deletedAt: null,
    });
    const session = await sessions.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${randomUUID().replace(/-/gu, '').padEnd(64, 'a')}`,
      deviceLabel: 'Integration Browser',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      revokeReason: null,
    });

    return {
      account: account.toObject() as AdminAccount & { _id: Types.ObjectId },
      session: session.toObject(),
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        adminAccountId: account._id,
        publicId: account.publicId,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        permission,
        permissionVersion: 1,
        sessionPublicId: session.publicId,
        credentialVersion: 1,
        authzVersion: 1,
      },
    };
  };

  const issueStoredReauth = async (
    fixture: FixtureAccount,
    targetPublicId: string,
    purpose: AdminReauthPurpose,
  ): Promise<string> => {
    const rawGrant = generateAdminSecurityGrant();
    await grants.create({
      adminAccountId: fixture.account._id,
      adminPublicId: fixture.account.publicId,
      sessionPublicId: fixture.session.publicId,
      purpose,
      targetPublicId,
      grantHash: hashAdminReauthGrant({
        rawGrant,
        purpose,
        adminPublicId: fixture.account.publicId,
        sessionPublicId: fixture.session.publicId,
        targetPublicId,
      }),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
    });
    return rawGrant;
  };

  const request = (
    actor: AdminAccountStatusActor,
    targetPublicId: string,
    status: AdminAccountStatus,
    overrides: Partial<UpdateAdminAccountStatusInput> = {},
  ): UpdateAdminAccountStatusInput => ({
    actor,
    targetPublicId,
    status,
    expectedVersion: 0,
    reasonCode:
      status === AdminAccountStatus.LOCKED
        ? 'security_lock'
        : 'approved_unlock',
    reasonNote: 'Approved integration lifecycle operation',
    correlationId:
      status === AdminAccountStatus.LOCKED
        ? 'admin-lock-20260813-0001'
        : 'admin-unlock-20260813-0001',
    ...overrides,
  });

  it('locks atomically, revokes every session and unlocks without reviving one', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_LOCK,
    );
    const managed = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'managed.admin',
      AdminRole.ADMIN,
      AdminPermission.USERS_VIEW,
    );
    await sessions.create({
      adminAccountId: managed.account._id,
      adminPublicId: managed.account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${'b'.repeat(64)}`,
      deviceLabel: 'Second Browser',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      revokeReason: null,
    });

    const locked = await statuses.updateStatus(
      request(
        superAdmin.actor,
        managed.account.publicId,
        AdminAccountStatus.LOCKED,
      ),
    );
    const storedLocked = await accounts
      .findById(managed.account._id)
      .select('+version +authzVersion')
      .lean()
      .exec();

    expect(locked.revokedSessionCount).toBe(2);
    expect(storedLocked).toMatchObject({
      status: AdminAccountStatus.LOCKED,
      version: 1,
      authzVersion: 2,
    });
    expect(storedLocked?.lockedAt).toBeInstanceOf(Date);
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokedAt: null,
      }),
    ).toBe(0);
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokeReason: AdminSessionRevokeReason.ACCOUNT_LOCKED,
      }),
    ).toBe(2);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.ADMIN_LOCKED,
        'target.publicId': managed.account.publicId,
        'metadata.affectedSessionCount': 2,
      }),
    ).toBe(1);

    const unlocked = await statuses.updateStatus(
      request(
        { ...superAdmin.actor, permission: AdminPermission.ADMINS_UNLOCK },
        managed.account.publicId,
        AdminAccountStatus.ACTIVE,
        { expectedVersion: 1 },
      ),
    );

    expect(unlocked).toMatchObject({
      admin: { status: AdminAccountStatus.ACTIVE, version: 2, lockedAt: null },
      revokedSessionCount: 0,
    });
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokedAt: null,
      }),
    ).toBe(0);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.ADMIN_UNLOCKED,
        'target.publicId': managed.account.publicId,
      }),
    ).toBe(1);
  });

  it('allows exactly one concurrent CAS winner for one Admin target', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_LOCK,
    );
    const managed = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'managed.admin',
      AdminRole.ADMIN,
      AdminPermission.USERS_VIEW,
    );
    const input = request(
      superAdmin.actor,
      managed.account.publicId,
      AdminAccountStatus.LOCKED,
    );

    const settled = await Promise.allSettled([
      statuses.updateStatus(input),
      statuses.updateStatus(input),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = settled.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConflictException),
    });
    expect(
      await audits.countDocuments({ action: AdminAuditAction.ADMIN_LOCKED }),
    ).toBe(1);
  });

  it('rolls back account, session revocation and audit when mandatory audit fails', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_LOCK,
    );
    const managed = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'managed.admin',
      AdminRole.ADMIN,
      AdminPermission.USERS_VIEW,
    );
    jest.spyOn(audit, 'record').mockImplementation((input) => {
      if (input.action === AdminAuditAction.ADMIN_LOCKED) {
        return Promise.reject(new Error('forced status audit failure'));
      }
      return Promise.resolve('aaud_23456789ABCDEFGH');
    });

    await expect(
      statuses.updateStatus(
        request(
          superAdmin.actor,
          managed.account.publicId,
          AdminAccountStatus.LOCKED,
        ),
      ),
    ).rejects.toThrow('forced status audit failure');

    const stored = await accounts
      .findById(managed.account._id)
      .select('+version +authzVersion')
      .lean()
      .exec();
    expect(stored).toMatchObject({
      status: AdminAccountStatus.ACTIVE,
      version: 0,
      authzVersion: 1,
      lockedAt: null,
    });
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokedAt: null,
      }),
    ).toBe(1);
    expect(await audits.countDocuments()).toBe(0);
  });

  it('serializes cross-locks and preserves one effective SuperAdmin', async () => {
    const first = await createEffectiveAccount(
      'adm_23456789ABCD',
      'first.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_LOCK,
    );
    const second = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'second.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_LOCK,
    );
    const firstGrant = await issueStoredReauth(
      first,
      second.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_LOCK,
    );
    const secondGrant = await issueStoredReauth(
      second,
      first.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_LOCK,
    );

    const settled = await Promise.allSettled([
      statuses.updateStatus(
        request(
          first.actor,
          second.account.publicId,
          AdminAccountStatus.LOCKED,
          {
            reauthGrant: firstGrant,
            correlationId: 'admin-cross-lock-20260813-0001',
          },
        ),
      ),
      statuses.updateStatus(
        request(
          second.actor,
          first.account.publicId,
          AdminAccountStatus.LOCKED,
          {
            reauthGrant: secondGrant,
            correlationId: 'admin-cross-lock-20260813-0002',
          },
        ),
      ),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await accounts.countDocuments({
        role: AdminRole.SUPER_ADMIN,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        lockedAt: null,
        deletedAt: null,
      }),
    ).toBe(1);
    expect(
      await audits.countDocuments({ action: AdminAuditAction.ADMIN_LOCKED }),
    ).toBe(1);
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(1);
    const serializedAudit = JSON.stringify(await audits.find().lean().exec());
    expect(serializedAudit).not.toContain(firstGrant);
    expect(serializedAudit).not.toContain(secondGrant);
  });
});
