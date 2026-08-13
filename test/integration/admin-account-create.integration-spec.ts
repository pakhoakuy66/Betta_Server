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
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import {
  type AdminLifecycleActor,
  type CreateAdminAccountInput,
} from '../../src/modules/admin/interfaces/admin-account-lifecycle.interface';
import {
  ADMIN_BOOTSTRAP_SECRET_STORE,
  type AdminBootstrapSecretStore,
  type PutAdminBootstrapSecretInput,
} from '../../src/modules/admin/interfaces/admin-bootstrap.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAccountCreationRequest } from '../../src/modules/admin/schemas/admin-account-creation-request.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminReauthGrant } from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountLifecycleService } from '../../src/modules/admin/services/admin-account-lifecycle.service';
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
const DATABASE_PREFIX = 'betta_adm_create_it_';
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

class InMemoryActivationSecretStore implements AdminBootstrapSecretStore {
  readonly writes: Array<
    PutAdminBootstrapSecretInput & Readonly<{ reference: string }>
  > = [];
  readonly revoked: string[] = [];

  assertReady(): void {}

  putVersion(input: PutAdminBootstrapSecretInput): Promise<string> {
    const reference = `sm://integration/admin-activation/versions/${String(
      this.writes.length + 1,
    )}`;
    this.writes.push({ ...input, reference });
    return Promise.resolve(reference);
  }

  revokeVersion(reference: string): Promise<void> {
    this.revoked.push(reference);
    return Promise.resolve();
  }

  reset(): void {
    this.writes.length = 0;
    this.revoked.length = 0;
  }
}

jest.setTimeout(120_000);

describe('SuperAdmin creates Admin MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let creationRequests: Model<AdminAccountCreationRequest>;
  let sessions: Model<AdminSession>;
  let grants: Model<AdminReauthGrant>;
  let audits: Model<AdminAuditEvent>;
  let lifecycle: AdminAccountLifecycleService;
  let audit: AdminAuditService;
  const secretStore = new InMemoryActivationSecretStore();

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
      .overrideProvider(ADMIN_BOOTSTRAP_SECRET_STORE)
      .useValue(secretStore)
      .compile();

    connection = moduleRef.get(getConnectionToken());
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    creationRequests = moduleRef.get(
      getModelToken(AdminAccountCreationRequest.name),
    );
    sessions = moduleRef.get(getModelToken(AdminSession.name));
    grants = moduleRef.get(getModelToken(AdminReauthGrant.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    lifecycle = moduleRef.get(AdminAccountLifecycleService);
    audit = moduleRef.get(AdminAuditService);
    await Promise.all([
      accounts.syncIndexes(),
      creationRequests.syncIndexes(),
      sessions.syncIndexes(),
      grants.syncIndexes(),
      audits.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    secretStore.reset();
    jest.restoreAllMocks();
    await Promise.all([
      accounts.deleteMany({}),
      creationRequests.deleteMany({}),
      sessions.deleteMany({}),
      grants.deleteMany({}),
      audits.collection.deleteMany({}),
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

  const fixture = async (): Promise<{
    actor: AdminLifecycleActor;
    rawReauthGrant: string;
  }> => {
    const [account] = await accounts.create([
      {
        publicId: 'adm_23456789ABCD',
        email: 'root.admin@betta.test',
        username: 'root.admin',
        displayName: 'Root Admin',
        role: AdminRole.SUPER_ADMIN,
        status: AdminAccountStatus.ACTIVE,
        passwordHash: '$2b$12$' + 'a'.repeat(53),
        mustChangePassword: false,
        mfaStatus: AdminMfaStatus.ACTIVE,
        encryptedTotpSecret: 'integration-ciphertext',
        activationGrantConsumedAt: new Date(),
        credentialVersion: 1,
        authzVersion: 1,
        permissionVersion: 1,
      },
    ]);
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
    const rawReauthGrant = generateAdminSecurityGrant();
    await grants.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      sessionPublicId: session.publicId,
      purpose: AdminReauthPurpose.ADMINS_CREATE,
      targetPublicId: 'security_admin_create',
      grantHash: hashAdminReauthGrant({
        rawGrant: rawReauthGrant,
        purpose: AdminReauthPurpose.ADMINS_CREATE,
        adminPublicId: account.publicId,
        sessionPublicId: session.publicId,
        targetPublicId: 'security_admin_create',
      }),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
    });
    return {
      rawReauthGrant,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        adminAccountId: account._id,
        publicId: account.publicId,
        username: account.username,
        displayName: account.displayName,
        role: AdminRole.SUPER_ADMIN,
        permission: AdminPermission.ADMINS_CREATE,
        permissionVersion: 1,
        sessionPublicId: session.publicId,
        credentialVersion: 1,
        authzVersion: 1,
      },
    };
  };

  const request = (
    value: Awaited<ReturnType<typeof fixture>>,
    suffix = '',
  ): CreateAdminAccountInput => ({
    actor: value.actor,
    email: ` NEW.ADMIN${suffix}@BETTA.TEST `,
    username: ` New.Admin${suffix} `,
    displayName: ' New Admin ',
    reauthGrant: value.rawReauthGrant,
    reasonCode: 'team_capacity',
    correlationId: `admin-create-20260812-${suffix.padStart(4, '0')}0001`,
    idempotencyKey: `admin-create-request-${suffix.padStart(4, '0')}0001`,
  });

  it('creates a hash-only pending ADMIN, consumes re-auth and audits atomically', async () => {
    const value = await fixture();
    const result = await lifecycle.createAdmin(request(value));
    const stored = await accounts
      .findOne({ publicId: result.admin.publicId })
      .select('+activationGrantHash +activationGrantExpiresAt')
      .lean()
      .exec();
    const consumed = await grants.findOne({ consumedAt: { $ne: null } }).lean();
    const event = await audits
      .findOne({ action: AdminAuditAction.ADMIN_CREATED })
      .lean();

    expect(stored).toMatchObject({
      email: 'new.admin@betta.test',
      username: 'new.admin',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.PENDING_ACTIVATION,
      mustChangePassword: true,
      mfaStatus: AdminMfaStatus.NOT_ENROLLED,
    });
    expect(stored?.activationGrantHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect(event?.target.publicId).toBe(result.admin.publicId);
    expect(JSON.stringify(result)).not.toContain(
      secretStore.writes[0].rawGrant,
    );
    expect(JSON.stringify(stored)).not.toContain(
      secretStore.writes[0].rawGrant,
    );

    const replayInput = request(value);
    const replay = await lifecycle.createAdmin({
      ...replayInput,
      actor: {
        ...replayInput.actor,
        sessionPublicId: 'ases_3456789ABCDEFGHJKLMNPQRS',
      },
    });
    expect(replay).toEqual(result);
    expect(secretStore.writes).toHaveLength(1);
  });

  it('rejects a reused idempotency key with a different payload before side effects', async () => {
    const value = await fixture();
    const firstInput = request(value);
    await lifecycle.createAdmin(firstInput);

    const secondRawGrant = generateAdminSecurityGrant();
    const secondGrant = await grants.create({
      adminAccountId: value.actor.adminAccountId,
      adminPublicId: value.actor.publicId,
      sessionPublicId: value.actor.sessionPublicId,
      purpose: AdminReauthPurpose.ADMINS_CREATE,
      targetPublicId: 'security_admin_create',
      grantHash: hashAdminReauthGrant({
        rawGrant: secondRawGrant,
        purpose: AdminReauthPurpose.ADMINS_CREATE,
        adminPublicId: value.actor.publicId,
        sessionPublicId: value.actor.sessionPublicId,
        targetPublicId: 'security_admin_create',
      }),
      credentialVersion: value.actor.credentialVersion,
      authzVersion: value.actor.authzVersion,
      permissionVersion: value.actor.permissionVersion,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
    });

    await expect(
      lifecycle.createAdmin({
        ...firstInput,
        email: 'different.admin@betta.test',
        username: 'different.admin',
        reauthGrant: secondRawGrant,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(secretStore.writes).toHaveLength(1);
    expect(secretStore.revoked).toHaveLength(0);
    expect(await accounts.countDocuments({ role: AdminRole.ADMIN })).toBe(1);
    expect(await creationRequests.countDocuments()).toBe(1);
    expect(
      await audits.countDocuments({
        action: AdminAuditAction.ADMIN_CREATED,
      }),
    ).toBe(1);

    const untouchedGrant = await grants
      .findById(secondGrant._id)
      .select('+grantHash')
      .lean()
      .exec();
    expect(untouchedGrant?.consumedAt).toBeNull();
  });

  it('allows one concurrent identity winner and compensates the loser secret', async () => {
    const first = await fixture();
    const secondRawGrant = generateAdminSecurityGrant();
    await grants.create({
      adminAccountId: first.actor.adminAccountId,
      adminPublicId: first.actor.publicId,
      sessionPublicId: first.actor.sessionPublicId,
      purpose: AdminReauthPurpose.ADMINS_CREATE,
      targetPublicId: 'security_admin_create',
      grantHash: hashAdminReauthGrant({
        rawGrant: secondRawGrant,
        purpose: AdminReauthPurpose.ADMINS_CREATE,
        adminPublicId: first.actor.publicId,
        sessionPublicId: first.actor.sessionPublicId,
        targetPublicId: 'security_admin_create',
      }),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
    });
    const second = { ...first, rawReauthGrant: secondRawGrant };
    const secondRequest = {
      ...request(second),
      idempotencyKey: 'admin-create-request-concurrent-0002',
    };

    const settled = await Promise.allSettled([
      lifecycle.createAdmin(request(first)),
      lifecycle.createAdmin(secondRequest),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(await accounts.countDocuments({ role: AdminRole.ADMIN })).toBe(1);
    expect(secretStore.revoked).toHaveLength(1);
  });

  it('rolls back account and re-auth consumption when mandatory audit fails', async () => {
    const value = await fixture();
    jest.spyOn(audit, 'record').mockImplementation((input) => {
      if (input.action === AdminAuditAction.ADMIN_CREATED) {
        return Promise.reject(new Error('forced audit failure'));
      }
      return Promise.resolve('aaud_23456789ABCDEFGH');
    });

    await expect(lifecycle.createAdmin(request(value))).rejects.toThrow(
      'forced audit failure',
    );

    expect(await accounts.countDocuments({ role: AdminRole.ADMIN })).toBe(0);
    const grant = await grants
      .findOne({ adminPublicId: value.actor.publicId })
      .lean();
    expect(grant?.consumedAt).toBeNull();
    expect(secretStore.revoked).toHaveLength(1);
  });
});
