import { randomUUID } from 'node:crypto';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
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
import { MongooseModule } from '@nestjs/mongoose';
import { type Connection, type Model } from 'mongoose';
import { AdminBootstrapModule } from '../../src/modules/admin/admin-bootstrap.module';
import {
  ADMIN_POLICY,
  createAdminPolicy,
} from '../../src/modules/admin/config/admin-policy.config';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  AdminAccountStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import {
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
  AdminBootstrapOutcome,
} from '../../src/modules/admin/constants/admin-bootstrap.constants';
import {
  ADMIN_BOOTSTRAP_SECRET_STORE,
  type AdminBootstrapSecretStore,
  type PutAdminBootstrapSecretInput,
} from '../../src/modules/admin/interfaces/admin-bootstrap.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import {
  AdminBootstrapState,
  ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX,
  ADMIN_BOOTSTRAP_STATE_KEY_INDEX,
} from '../../src/modules/admin/schemas/admin-bootstrap-state.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminBootstrapService } from '../../src/modules/admin/services/admin-bootstrap.service';
import { hashAdminActivationGrant } from '../../src/modules/admin/utils/admin-activation-grant';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_boot_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const TEST_ADMIN_SECRET_VALUES = Object.fromEntries(
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

const TEST_ADMIN_SECRETS = createAdminSecrets({
  source: { get: (key: string): unknown => TEST_ADMIN_SECRET_VALUES[key] },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});

type SecretWrite = Readonly<
  PutAdminBootstrapSecretInput & {
    reference: string;
  }
>;

class InMemoryBootstrapSecretStore implements AdminBootstrapSecretStore {
  readonly writes: SecretWrite[] = [];
  readonly revoked: string[] = [];
  failPut = false;

  assertReady(): void {}

  putVersion(input: PutAdminBootstrapSecretInput): Promise<string> {
    if (this.failPut) {
      return Promise.reject(new Error('simulated provider outage'));
    }
    const reference =
      `sm://betta/admin-bootstrap/versions/` +
      String(this.writes.length + 1).padStart(8, '0');
    this.writes.push(Object.freeze({ ...input, reference }));
    return Promise.resolve(reference);
  }

  revokeVersion(reference: string): Promise<void> {
    this.revoked.push(reference);
    return Promise.resolve();
  }

  reset(): void {
    this.writes.length = 0;
    this.revoked.length = 0;
    this.failPut = false;
  }
}

const request = (reissue = false) => ({
  identity: {
    email: 'initial.superadmin@betta.test',
    username: 'initial.superadmin',
    displayName: 'Initial SuperAdmin',
  },
  operatorReference: 'deploy.pipeline@example.test',
  correlationId: 'bootstrap-test-00000001',
  reissue,
});

jest.setTimeout(90_000);

describe('Admin bootstrap MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let stateModel: Model<AdminBootstrapState>;
  let auditModel: Model<AdminAuditEvent>;
  let service: AdminBootstrapService;
  let audit: AdminAuditService;
  const secretStore = new InMemoryBootstrapSecretStore();

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if (Buffer.byteLength(databaseName, 'utf8') > 38) {
      throw new Error('Tên integration database vượt giới hạn 38 byte');
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
        AdminBootstrapModule,
      ],
    })
      .overrideProvider(ADMIN_SECRETS)
      .useValue(TEST_ADMIN_SECRETS)
      .overrideProvider(ADMIN_POLICY)
      .useValue(
        createAdminPolicy({
          get: (key: string): unknown =>
            key === 'NODE_ENV' ? AdminBootstrapEnvironment.TEST : undefined,
        }),
      )
      .overrideProvider(ADMIN_BOOTSTRAP_SECRET_STORE)
      .useValue(secretStore)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(AdminAccount.name));
    stateModel = moduleRef.get(getModelToken(AdminBootstrapState.name));
    auditModel = moduleRef.get(getModelToken(AdminAuditEvent.name));
    service = moduleRef.get(AdminBootstrapService);
    audit = moduleRef.get(AdminAuditService);
    await Promise.all([
      accountModel.syncIndexes(),
      stateModel.syncIndexes(),
      auditModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    secretStore.reset();
    await Promise.all([
      accountModel.collection.deleteMany({}),
      stateModel.collection.deleteMany({}),
      auditModel.collection.deleteMany({}),
    ]);
    jest.restoreAllMocks();
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

  it('creates the singleton, SuperAdmin and audit without persisting raw grant', async () => {
    const startedAt = Date.now();
    const result = await service.execute(request());
    const finishedAt = Date.now();
    expect(result.outcome).toBe(AdminBootstrapOutcome.CREATED);
    expect(result.secretReference).toMatch(/^sm:\/\//);
    expect(secretStore.writes).toHaveLength(1);

    const [account, state, event] = await Promise.all([
      accountModel
        .findOne({ role: AdminRole.SUPER_ADMIN })
        .select('+activationGrantHash +activationGrantExpiresAt')
        .lean()
        .exec(),
      stateModel
        .findOne({ key: ADMIN_BOOTSTRAP_SINGLETON_KEY })
        .select('+grantHash +secretReference +consumedAt')
        .lean()
        .exec(),
      auditModel.findOne().lean().exec(),
    ]);
    expect(account).toEqual(
      expect.objectContaining({
        publicId: result.adminPublicId,
        status: AdminAccountStatus.PENDING_ACTIVATION,
        role: AdminRole.SUPER_ADMIN,
        mustChangePassword: true,
      }),
    );
    expect(state).toEqual(
      expect.objectContaining({
        adminPublicId: result.adminPublicId,
        purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
        environment: AdminBootstrapEnvironment.TEST,
        generation: 1,
        consumedAt: null,
        secretReference: result.secretReference,
      }),
    );
    const write = secretStore.writes[0];
    if (!write) throw new Error('Expected one Secret Manager write');
    expect(state?.grantHash).toBe(
      hashAdminActivationGrant(write.rawGrant, write.context),
    );
    expect(account?.activationGrantHash).toBe(state?.grantHash);
    const expectedTtlMs = 900_000;
    expect(account?.activationGrantExpiresAt?.getTime()).toBeGreaterThanOrEqual(
      startedAt + expectedTtlMs,
    );
    expect(account?.activationGrantExpiresAt?.getTime()).toBeLessThanOrEqual(
      finishedAt + expectedTtlMs,
    );
    expect(state?.grantExpiresAt.getTime()).toBe(
      account?.activationGrantExpiresAt?.getTime(),
    );
    expect(result.expiresAt).toBe(state?.grantExpiresAt.toISOString());
    expect(event).toEqual(
      expect.objectContaining({
        action: AdminAuditAction.BOOTSTRAP_GRANT_ISSUED,
        actor: expect.objectContaining({
          type: AdminAuditActorType.DEPLOYMENT_OPERATOR,
        }),
      }),
    );

    const persisted = JSON.stringify({ account, state, event, result });
    expect(persisted).not.toContain(write.rawGrant);
  });

  it('is idempotent and never creates a second SuperAdmin', async () => {
    const first = await service.execute(request());
    const second = await service.execute(request());

    expect(first.outcome).toBe(AdminBootstrapOutcome.CREATED);
    expect(second).toEqual(
      expect.objectContaining({
        outcome: AdminBootstrapOutcome.SKIPPED,
        adminPublicId: first.adminPublicId,
      }),
    );
    expect(secretStore.writes).toHaveLength(1);
    await expect(
      accountModel.countDocuments({ role: AdminRole.SUPER_ADMIN }),
    ).resolves.toBe(1);
  });

  it('allows one concurrent winner and compensates the losing secret', async () => {
    const outcomes = await Promise.all([
      service.execute(request()),
      service.execute(request()),
      service.execute(request()),
    ]);
    expect(
      outcomes.filter(
        (result) => result.outcome === AdminBootstrapOutcome.CREATED,
      ),
    ).toHaveLength(1);
    expect(
      outcomes.filter(
        (result) => result.outcome === AdminBootstrapOutcome.SKIPPED,
      ),
    ).toHaveLength(2);
    expect(secretStore.revoked).toHaveLength(2);
    await expect(stateModel.countDocuments()).resolves.toBe(1);
    await expect(
      accountModel.countDocuments({ role: AdminRole.SUPER_ADMIN }),
    ).resolves.toBe(1);
  });

  it('reissues only a pending account and never overwrites its identity', async () => {
    const created = await service.execute(request());
    const firstWrite = secretStore.writes[0];
    if (!firstWrite) throw new Error('Expected initial Secret Manager write');
    const reissued = await service.execute({
      ...request(true),
      identity: {
        email: 'different@betta.test',
        username: 'different.admin',
        displayName: 'Different Name',
      },
    });
    expect(reissued.outcome).toBe(AdminBootstrapOutcome.REISSUED);
    expect(reissued.adminPublicId).toBe(created.adminPublicId);

    const [account, state] = await Promise.all([
      accountModel
        .findOne({ publicId: created.adminPublicId })
        .select('+activationGrantHash')
        .lean()
        .exec(),
      stateModel
        .findOne({ key: ADMIN_BOOTSTRAP_SINGLETON_KEY })
        .select('+grantHash +secretReference')
        .lean()
        .exec(),
    ]);
    expect(account).toEqual(
      expect.objectContaining({
        email: request().identity.email,
        username: request().identity.username,
        displayName: request().identity.displayName,
      }),
    );
    expect(state).toEqual(
      expect.objectContaining({
        generation: 2,
        secretReference: reissued.secretReference,
      }),
    );
    expect(account?.activationGrantHash).toBe(state?.grantHash);
    expect(secretStore.writes).toHaveLength(2);
    const secondWrite = secretStore.writes[1];
    if (!secondWrite) throw new Error('Expected reissued Secret Manager write');
    expect(secondWrite.rawGrant).not.toBe(firstWrite.rawGrant);
    expect(secondWrite.reference).not.toBe(firstWrite.reference);
    expect(
      hashAdminActivationGrant(firstWrite.rawGrant, firstWrite.context),
    ).not.toBe(state?.grantHash);
    expect(
      hashAdminActivationGrant(secondWrite.rawGrant, secondWrite.context),
    ).toBe(state?.grantHash);
  });

  it('rolls back MongoDB and revokes the secret when audit persistence fails', async () => {
    jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit down'));
    await expect(service.execute(request())).rejects.toThrow(
      'Không thể hoàn tất Admin bootstrap',
    );

    await expect(accountModel.countDocuments()).resolves.toBe(0);
    await expect(stateModel.countDocuments()).resolves.toBe(0);
    expect(secretStore.writes).toHaveLength(1);
    expect(secretStore.revoked).toEqual([secretStore.writes[0]?.reference]);
  });

  it('writes nothing when Secret Manager rejects the grant', async () => {
    secretStore.failPut = true;
    await expect(service.execute(request())).rejects.toThrow(
      'simulated provider outage',
    );
    await expect(accountModel.countDocuments()).resolves.toBe(0);
    await expect(stateModel.countDocuments()).resolves.toBe(0);
    await expect(auditModel.countDocuments()).resolves.toBe(0);
  });

  it('defines singleton indexes without TTL deletion', async () => {
    const indexes = (await stateModel.collection
      .listIndexes()
      .toArray()) as Array<{
      name?: string;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: ADMIN_BOOTSTRAP_STATE_KEY_INDEX,
          unique: true,
        }),
        expect.objectContaining({
          name: ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX,
          unique: true,
        }),
      ]),
    );
    expect(
      indexes.some((index) => index.expireAfterSeconds !== undefined),
    ).toBe(false);
  });
});
