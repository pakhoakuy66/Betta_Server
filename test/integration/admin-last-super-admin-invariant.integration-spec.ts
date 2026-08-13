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
import { MongoServerError } from 'mongodb';
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
import { AdminAccountDeletionAction } from '../../src/modules/admin/constants/admin-account-deletion.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { ADMIN_LIFECYCLE_COORDINATOR_KEY } from '../../src/modules/admin/constants/admin-lifecycle.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import {
  type AdminAccountDeletionActor,
  type UpdateAdminAccountDeletionInput,
} from '../../src/modules/admin/interfaces/admin-account-deletion.interface';
import {
  type AdminAccountStatusActor,
  type UpdateAdminAccountStatusInput,
} from '../../src/modules/admin/interfaces/admin-account-status.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminLifecycleCoordinator } from '../../src/modules/admin/schemas/admin-lifecycle-coordinator.schema';
import { AdminReauthGrant } from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountDeletionService } from '../../src/modules/admin/services/admin-account-deletion.service';
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
const DATABASE_PREFIX = 'betta_adm_last_root_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 6);

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `last-root-integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 61).toString('base64'),
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

type SuperAdminFixture = Readonly<{
  account: AdminAccount & { _id: Types.ObjectId };
  session: AdminSession;
}>;

jest.setTimeout(120_000);

describe('Last SuperAdmin invariant MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let sessions: Model<AdminSession>;
  let grants: Model<AdminReauthGrant>;
  let audits: Model<AdminAuditEvent>;
  let coordinators: Model<AdminLifecycleCoordinator>;
  let statuses: AdminAccountStatusService;
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
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
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
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    sessions = moduleRef.get(getModelToken(AdminSession.name));
    grants = moduleRef.get(getModelToken(AdminReauthGrant.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    coordinators = moduleRef.get(getModelToken(AdminLifecycleCoordinator.name));
    statuses = moduleRef.get(AdminAccountStatusService);
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

  const createSuperAdmin = async (
    publicId: string,
    username: string,
    mfaStatus: AdminMfaStatus = AdminMfaStatus.ACTIVE,
  ): Promise<SuperAdminFixture> => {
    const account = await accounts.create({
      publicId,
      email: `${username}@betta.test`,
      username,
      displayName: username,
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus,
      encryptedTotpSecret:
        mfaStatus === AdminMfaStatus.ACTIVE
          ? `atotp_v1.integration.${publicId}`
          : undefined,
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
    };
  };

  const actor = <T extends AdminPermission>(
    fixture: SuperAdminFixture,
    permission: T,
  ): AdminAccountStatusActor & AdminAccountDeletionActor => ({
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    adminAccountId: fixture.account._id,
    publicId: fixture.account.publicId,
    username: fixture.account.username,
    displayName: fixture.account.displayName,
    role: AdminRole.SUPER_ADMIN,
    permission,
    permissionVersion: 1,
    sessionPublicId: fixture.session.publicId,
    credentialVersion: 1,
    authzVersion: 1,
  });

  const issueStoredReauth = async (
    fixture: SuperAdminFixture,
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

  const lockInput = (
    owner: SuperAdminFixture,
    targetPublicId: string,
    reauthGrant: string,
  ): UpdateAdminAccountStatusInput => ({
    actor: actor(owner, AdminPermission.ADMINS_LOCK),
    targetPublicId,
    status: AdminAccountStatus.LOCKED,
    expectedVersion: 0,
    reasonCode: 'last_root_invariant',
    reasonNote: 'Approved integration lock operation',
    correlationId: `admin-last-root-lock-${randomUUID()}`,
    reauthGrant,
  });

  const deleteInput = (
    owner: SuperAdminFixture,
    targetPublicId: string,
    reauthGrant: string,
  ): UpdateAdminAccountDeletionInput => ({
    actor: actor(owner, AdminPermission.ADMINS_DELETE),
    targetPublicId,
    action: AdminAccountDeletionAction.SOFT_DELETE,
    expectedVersion: 0,
    reasonCode: 'last_root_invariant',
    reasonNote: 'Approved integration delete operation',
    correlationId: `admin-last-root-delete-${randomUUID()}`,
    reauthGrant,
  });

  it('serializes a mixed lock/delete race and keeps one effective SuperAdmin', async () => {
    const first = await createSuperAdmin('adm_23456789ABCD', 'first.root');
    const second = await createSuperAdmin('adm_3456789ABCDE', 'second.root');
    const lockGrant = await issueStoredReauth(
      first,
      second.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_LOCK,
    );
    const deleteGrant = await issueStoredReauth(
      second,
      first.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_DELETE,
    );

    const settled = await Promise.allSettled([
      statuses.updateStatus(
        lockInput(first, second.account.publicId, lockGrant),
      ),
      deletions.updateDeletion(
        deleteInput(second, first.account.publicId, deleteGrant),
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
      await audits.countDocuments({
        action: {
          $in: [AdminAuditAction.ADMIN_LOCKED, AdminAuditAction.ADMIN_DELETED],
        },
      }),
    ).toBe(1);
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(1);
  });

  it('allows locking a non-effective SuperAdmin when another effective one remains', async () => {
    const owner = await createSuperAdmin('adm_23456789ABCD', 'owner.root');
    const target = await createSuperAdmin(
      'adm_3456789ABCDE',
      'recovery.root',
      AdminMfaStatus.RESET_REQUIRED,
    );
    const grant = await issueStoredReauth(
      owner,
      target.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_LOCK,
    );

    await expect(
      statuses.updateStatus(lockInput(owner, target.account.publicId, grant)),
    ).resolves.toMatchObject({
      admin: { status: AdminAccountStatus.LOCKED },
    });
    expect(
      await accounts.countDocuments({
        _id: owner.account._id,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('retries the complete transaction after a transient audit failure', async () => {
    const owner = await createSuperAdmin('adm_23456789ABCD', 'owner.root');
    const target = await createSuperAdmin('adm_3456789ABCDE', 'target.root');
    const grant = await issueStoredReauth(
      owner,
      target.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_LOCK,
    );
    const transient = new MongoServerError({
      message: 'forced transient write conflict',
      code: 112,
    });
    transient.addErrorLabel('TransientTransactionError');
    const auditSpy = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(transient);

    await expect(
      statuses.updateStatus(lockInput(owner, target.account.publicId, grant)),
    ).resolves.toMatchObject({
      admin: { status: AdminAccountStatus.LOCKED, version: 1 },
    });
    expect(auditSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.ADMIN_LOCKED,
        'target.publicId': target.account.publicId,
      }),
    ).toBe(1);
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(1);
  });

  it('rolls back target, session, grant and coordinator when audit fails', async () => {
    const owner = await createSuperAdmin('adm_23456789ABCD', 'owner.root');
    const target = await createSuperAdmin('adm_3456789ABCDE', 'target.root');
    const grant = await issueStoredReauth(
      owner,
      target.account.publicId,
      AdminReauthPurpose.SUPER_ADMIN_DELETE,
    );
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('forced mandatory audit failure'));

    await expect(
      deletions.updateDeletion(
        deleteInput(owner, target.account.publicId, grant),
      ),
    ).rejects.toThrow('forced mandatory audit failure');

    expect(
      await accounts.countDocuments({
        _id: target.account._id,
        status: AdminAccountStatus.ACTIVE,
        version: 0,
        authzVersion: 1,
        deletedAt: null,
      }),
    ).toBe(1);
    expect(
      await sessions.countDocuments({
        adminAccountId: target.account._id,
        revokedAt: null,
      }),
    ).toBe(1);
    expect(await grants.countDocuments({ consumedAt: null })).toBe(1);
    expect(
      await audits.countDocuments({ action: AdminAuditAction.ADMIN_DELETED }),
    ).toBe(0);
    expect(
      await coordinators.countDocuments({
        key: ADMIN_LIFECYCLE_COORDINATOR_KEY,
        revision: 0,
      }),
    ).toBe(1);
  });
});
