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
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAccountDeletionAction } from '../../src/modules/admin/constants/admin-account-deletion.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../../src/modules/admin/constants/admin-session.constants';
import {
  type AdminAccountDeletionActor,
  type UpdateAdminAccountDeletionInput,
} from '../../src/modules/admin/interfaces/admin-account-deletion.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminLifecycleCoordinator } from '../../src/modules/admin/schemas/admin-lifecycle-coordinator.schema';
import { AdminReauthGrant } from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountDeletionService } from '../../src/modules/admin/services/admin-account-deletion.service';
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
const DATABASE_PREFIX = 'betta_adm_delete_it_';
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
  actor: AdminAccountDeletionActor;
}>;

jest.setTimeout(120_000);

describe('Admin account deletion MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let grants: Model<AdminReauthGrant>;
  let audits: Model<AdminAuditEvent>;
  let coordinators: Model<AdminLifecycleCoordinator>;
  let deletions: AdminAccountDeletionService;
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
    deletions = moduleRef.get(AdminAccountDeletionService);
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
    actor: AdminAccountDeletionActor,
    targetPublicId: string,
    action: AdminAccountDeletionAction,
    overrides: Partial<UpdateAdminAccountDeletionInput> = {},
  ): UpdateAdminAccountDeletionInput => ({
    actor,
    targetPublicId,
    action,
    expectedVersion: 0,
    reasonCode:
      action === AdminAccountDeletionAction.SOFT_DELETE
        ? 'security_offboarding'
        : 'approved_restore',
    reasonNote: 'Approved integration deletion lifecycle operation',
    correlationId:
      action === AdminAccountDeletionAction.SOFT_DELETE
        ? 'admin-delete-20260813-0001'
        : 'admin-restore-20260813-0001',
    ...overrides,
  });

  it('soft-deletes atomically, revokes every session and restores to LOCKED', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
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

    const deleted = await deletions.updateDeletion(
      request(
        superAdmin.actor,
        managed.account.publicId,
        AdminAccountDeletionAction.SOFT_DELETE,
      ),
    );
    const storedDeleted = await accounts
      .findById(managed.account._id)
      .select('+version +authzVersion')
      .lean()
      .exec();

    expect(deleted.revokedSessionCount).toBe(2);
    expect(storedDeleted).toMatchObject({
      status: AdminAccountStatus.SOFT_DELETED,
      version: 1,
      authzVersion: 2,
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
    });
    expect(storedDeleted?.deletedAt).toBeInstanceOf(Date);
    expect(storedDeleted?.lockedAt).toBeNull();
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokedAt: null,
      }),
    ).toBe(0);
    expect(
      await sessions.countDocuments({
        adminAccountId: managed.account._id,
        revokeReason: AdminSessionRevokeReason.ACCOUNT_DELETED,
      }),
    ).toBe(2);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.ADMIN_DELETED,
        'target.publicId': managed.account.publicId,
        'metadata.affectedSessionCount': 2,
      }),
    ).toBe(1);

    const restored = await deletions.updateDeletion(
      request(
        { ...superAdmin.actor, permission: AdminPermission.ADMINS_RESTORE },
        managed.account.publicId,
        AdminAccountDeletionAction.RESTORE,
        { expectedVersion: 1 },
      ),
    );

    expect(restored).toMatchObject({
      admin: {
        status: AdminAccountStatus.LOCKED,
        version: 2,
        deletionOrigin: null,
        deletedAt: null,
      },
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
        action: AdminAuditAction.ADMIN_RESTORED,
        'target.publicId': managed.account.publicId,
      }),
    ).toBe(1);
  });

  it('allows exactly one concurrent delete CAS winner for one Admin target', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
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
      AdminAccountDeletionAction.SOFT_DELETE,
    );

    const settled = await Promise.allSettled([
      deletions.updateDeletion(input),
      deletions.updateDeletion(input),
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
      await audits.countDocuments({ action: AdminAuditAction.ADMIN_DELETED }),
    ).toBe(1);
  });

  it('rolls back account, session revocation and audit when mandatory audit fails', async () => {
    const superAdmin = await createEffectiveAccount(
      'adm_23456789ABCD',
      'root.admin',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
    );
    const managed = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'managed.admin',
      AdminRole.ADMIN,
      AdminPermission.USERS_VIEW,
    );
    jest.spyOn(audit, 'record').mockImplementation((input) => {
      if (input.action === AdminAuditAction.ADMIN_DELETED) {
        return Promise.reject(new Error('forced deletion audit failure'));
      }
      return Promise.resolve('aaud_23456789ABCDEFGH');
    });

    await expect(
      deletions.updateDeletion(
        request(
          superAdmin.actor,
          managed.account.publicId,
          AdminAccountDeletionAction.SOFT_DELETE,
        ),
      ),
    ).rejects.toThrow('forced deletion audit failure');

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

  it('deletes a locked SuperAdmin when one different effective SuperAdmin remains', async () => {
    const effective = await createEffectiveAccount(
      'adm_23456789ABCD',
      'effective.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
    );
    const locked = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'locked.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
    );
    await accounts.updateOne(
      { _id: locked.account._id },
      {
        $set: { status: AdminAccountStatus.LOCKED, lockedAt: new Date() },
        $inc: { authzVersion: 1, version: 1 },
      },
    );
    const reauthGrant = await issueStoredReauth(
      effective,
      locked.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_DELETE,
    );

    await expect(
      deletions.updateDeletion(
        request(
          effective.actor,
          locked.account.publicId,
          AdminAccountDeletionAction.SOFT_DELETE,
          {
            expectedVersion: 1,
            reauthGrant,
            correlationId: 'admin-delete-locked-root-20260813-0001',
          },
        ),
      ),
    ).resolves.toMatchObject({
      admin: { status: AdminAccountStatus.SOFT_DELETED },
    });
    expect(
      await accounts.countDocuments({
        _id: effective.account._id,
        role: AdminRole.SUPER_ADMIN,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        lockedAt: null,
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('serializes cross-deletes and preserves one effective SuperAdmin', async () => {
    const first = await createEffectiveAccount(
      'adm_23456789ABCD',
      'first.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
    );
    const second = await createEffectiveAccount(
      'adm_3456789ABCDE',
      'second.root',
      AdminRole.SUPER_ADMIN,
      AdminPermission.ADMINS_DELETE,
    );
    const firstGrant = await issueStoredReauth(
      first,
      second.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_DELETE,
    );
    const secondGrant = await issueStoredReauth(
      second,
      first.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_DELETE,
    );

    const settled = await Promise.allSettled([
      deletions.updateDeletion(
        request(
          first.actor,
          second.account.publicId,
          AdminAccountDeletionAction.SOFT_DELETE,
          {
            reauthGrant: firstGrant,
            correlationId: 'admin-cross-delete-20260813-0001',
          },
        ),
      ),
      deletions.updateDeletion(
        request(
          second.actor,
          first.account.publicId,
          AdminAccountDeletionAction.SOFT_DELETE,
          {
            reauthGrant: secondGrant,
            correlationId: 'admin-cross-delete-20260813-0002',
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
      await audits.countDocuments({ action: AdminAuditAction.ADMIN_DELETED }),
    ).toBe(1);
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(1);
    const serializedAudit = JSON.stringify(await audits.find().lean().exec());
    expect(serializedAudit).not.toContain(firstGrant);
    expect(serializedAudit).not.toContain(secondGrant);
  });
});
