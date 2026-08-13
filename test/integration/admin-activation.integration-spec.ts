import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongooseModule } from '@nestjs/mongoose';
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
  AdminMfaStatus,
} from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAuditAction } from '../../src/modules/admin/constants/admin-audit.constants';
import {
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminBootstrapEnvironment,
} from '../../src/modules/admin/constants/admin-bootstrap.constants';
import {
  ADMIN_BOOTSTRAP_SECRET_STORE,
  type AdminBootstrapSecretStore,
  type PutAdminBootstrapSecretInput,
} from '../../src/modules/admin/interfaces/admin-bootstrap.interface';
import { type RecordAdminAuditInput } from '../../src/modules/admin/interfaces/admin-audit.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminBootstrapState } from '../../src/modules/admin/schemas/admin-bootstrap-state.schema';
import { AdminLoginProtection } from '../../src/modules/admin/schemas/admin-login-protection.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminActivationService } from '../../src/modules/admin/services/admin-activation.service';
import { AdminAuthService } from '../../src/modules/admin/services/admin-auth.service';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminBootstrapService } from '../../src/modules/admin/services/admin-bootstrap.service';
import { createAdminTotp } from '../../src/modules/admin/utils/admin-totp';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const MAX_DATABASE_NAME_BYTES = 38;
const DATABASE_PREFIX = 'betta_adm_act_it_';
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
const TEST_ADMIN_POLICY = createAdminPolicy({
  get: (key: string): unknown =>
    key === 'NODE_ENV' ? AdminBootstrapEnvironment.TEST : undefined,
});

type SecretWrite = Readonly<
  PutAdminBootstrapSecretInput & { reference: string }
>;

class InMemoryBootstrapSecretStore implements AdminBootstrapSecretStore {
  readonly writes: SecretWrite[] = [];

  assertReady(): void {}

  putVersion(input: PutAdminBootstrapSecretInput): Promise<string> {
    const reference = `sm://activation-test/${String(this.writes.length + 1)}`;
    this.writes.push(Object.freeze({ ...input, reference }));
    return Promise.resolve(reference);
  }

  revokeVersion(): Promise<void> {
    return Promise.resolve();
  }

  reset(): void {
    this.writes.length = 0;
  }
}

const decodeBase32 = (value: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new TypeError('Invalid Base32 test fixture');
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

jest.setTimeout(120_000);

describe('Admin activation MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let stateModel: Model<AdminBootstrapState>;
  let sessionModel: Model<AdminSession>;
  let auditModel: Model<AdminAuditEvent>;
  let protectionModel: Model<AdminLoginProtection>;
  let bootstrap: AdminBootstrapService;
  let activation: AdminActivationService;
  let auth: AdminAuthService;
  let audit: AdminAuditService;
  const secretStore = new InMemoryBootstrapSecretStore();

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chua duoc cau hinh`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES la bat buoc`);
    }
    if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
      throw new Error('Ten Admin activation integration database vuot 38 byte');
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI khong duoc trung runtime URI');
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
      .useValue(TEST_ADMIN_POLICY)
      .overrideProvider(ADMIN_BOOTSTRAP_SECRET_STORE)
      .useValue(secretStore)
      .compile();

    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(AdminAccount.name));
    stateModel = moduleRef.get(getModelToken(AdminBootstrapState.name));
    sessionModel = moduleRef.get(getModelToken(AdminSession.name));
    auditModel = moduleRef.get(getModelToken(AdminAuditEvent.name));
    protectionModel = moduleRef.get(getModelToken(AdminLoginProtection.name));
    bootstrap = moduleRef.get(AdminBootstrapService);
    activation = moduleRef.get(AdminActivationService);
    auth = moduleRef.get(AdminAuthService);
    audit = moduleRef.get(AdminAuditService);

    await Promise.all([
      accountModel.syncIndexes(),
      stateModel.syncIndexes(),
      sessionModel.syncIndexes(),
      auditModel.syncIndexes(),
      protectionModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    secretStore.reset();
    await Promise.all([
      accountModel.deleteMany({}),
      stateModel.deleteMany({}),
      sessionModel.deleteMany({}),
      auditModel.collection.deleteMany({}),
      protectionModel.deleteMany({}),
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

  const bootstrapFixture = async () => {
    const result = await bootstrap.execute({
      identity: {
        email: 'initial.superadmin@betta.test',
        username: 'initial.superadmin',
        displayName: 'Initial SuperAdmin',
      },
      operatorReference: 'integration.operator',
      correlationId: `activation-${randomUUID()}`,
      reissue: false,
    });
    const write = secretStore.writes[0];
    if (!write) throw new Error('Expected bootstrap secret write');
    if (!result.adminPublicId) {
      throw new Error('Expected bootstrap Admin public ID');
    }
    return {
      adminPublicId: result.adminPublicId,
      activationGrant: write.rawGrant,
    };
  };

  const start = (fixture: Awaited<ReturnType<typeof bootstrapFixture>>) =>
    activation.begin({
      ...fixture,
      trustedClientIp: '203.0.113.10',
    });

  const complete = (
    fixture: Awaited<ReturnType<typeof bootstrapFixture>>,
    secretBase32: string,
  ) => {
    const step = Math.floor(Date.now() / 30_000);
    return activation.complete({
      ...fixture,
      newPassword: 'A production password!2026',
      confirmPassword: 'A production password!2026',
      totpToken: createAdminTotp(decodeBase32(secretBase32), step, 6),
      trustedClientIp: '203.0.113.10',
      userAgent: 'Chrome on Windows',
    });
  };

  it('activates once, creates a session and never persists raw credentials', async () => {
    const fixture = await bootstrapFixture();
    const challenge = await start(fixture);
    const result = await complete(fixture, challenge.secretBase32);

    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.authentication.accessToken.split('.')).toHaveLength(3);
    expect(JSON.stringify(result.authentication)).not.toContain(
      fixture.activationGrant,
    );

    const [account, state, sessionCount, activationAuditCount, mfaAuditCount] =
      await Promise.all([
        accountModel
          .findOne({ publicId: fixture.adminPublicId })
          .select(
            '+passwordHash +encryptedTotpSecret +recoveryCodeHashes ' +
              '+activationGrantHash +activationGrantExpiresAt ' +
              '+pendingEncryptedTotpSecret +pendingTotpEnrollmentExpiresAt',
          )
          .lean()
          .exec(),
        stateModel
          .findOne({ key: ADMIN_BOOTSTRAP_SINGLETON_KEY })
          .select('+grantHash +consumedAt')
          .lean()
          .exec(),
        sessionModel.countDocuments({ adminPublicId: fixture.adminPublicId }),
        auditModel.countDocuments({
          action: AdminAuditAction.ACTIVATION_CONSUMED,
        }),
        auditModel.countDocuments({ action: AdminAuditAction.MFA_ENROLLED }),
      ]);

    expect(account).toEqual(
      expect.objectContaining({
        status: AdminAccountStatus.ACTIVE,
        mustChangePassword: false,
        mfaStatus: AdminMfaStatus.ACTIVE,
      }),
    );

    expect(account).not.toHaveProperty('activationGrantHash');
    expect(account).not.toHaveProperty('activationGrantExpiresAt');
    expect(account).not.toHaveProperty('pendingEncryptedTotpSecret');
    expect(account).not.toHaveProperty('pendingTotpEnrollmentExpiresAt');
    expect(account?.passwordHash).not.toContain('A production password!2026');
    expect(account?.recoveryCodeHashes).toHaveLength(10);
    expect(state?.consumedAt).toBeInstanceOf(Date);
    expect(sessionCount).toBe(1);
    expect(activationAuditCount).toBe(1);
    expect(mfaAuditCount).toBe(1);

    await expect(
      complete(fixture, challenge.secretBase32),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies normal login before activation and allows it after completion', async () => {
    const fixture = await bootstrapFixture();
    const challenge = await start(fixture);
    const password = 'A production password!2026';

    await expect(
      auth.login({
        email: 'initial.superadmin@betta.test',
        password,
        totpToken: '123456',
        trustedClientIp: '203.0.113.20',
        userAgent: 'Chrome on Windows',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      sessionModel.countDocuments({ adminPublicId: fixture.adminPublicId }),
    ).resolves.toBe(0);

    await complete(fixture, challenge.secretBase32);
    const nextStep = Math.floor(Date.now() / 30_000) + 1;
    const login = await auth.login({
      email: 'initial.superadmin@betta.test',
      password,
      totpToken: createAdminTotp(
        decodeBase32(challenge.secretBase32),
        nextStep,
        6,
      ),
      trustedClientIp: '203.0.113.20',
      userAgent: 'Chrome on Windows',
    });

    expect(login.accessToken.split('.')).toHaveLength(3);
    await expect(
      sessionModel.countDocuments({ adminPublicId: fixture.adminPublicId }),
    ).resolves.toBe(2);
  });

  it('invalidates the previous TOTP challenge when enrollment restarts', async () => {
    const fixture = await bootstrapFixture();
    const oldChallenge = await start(fixture);
    const currentChallenge = await start(fixture);

    await expect(
      complete(fixture, oldChallenge.secretBase32),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      complete(fixture, currentChallenge.secretBase32),
    ).resolves.toEqual(
      expect.objectContaining({ recoveryCodes: expect.any(Array) }),
    );
  });

  it('allows exactly one concurrent completion winner', async () => {
    const fixture = await bootstrapFixture();
    const challenge = await start(fixture);

    const results = await Promise.allSettled([
      complete(fixture, challenge.secretBase32),
      complete(fixture, challenge.secretBase32),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      sessionModel.countDocuments({ adminPublicId: fixture.adminPublicId }),
    ).resolves.toBe(1);
    await expect(
      auditModel.countDocuments({
        action: AdminAuditAction.ACTIVATION_CONSUMED,
      }),
    ).resolves.toBe(1);
  });

  it('rolls back account, state and session when activation audit fails', async () => {
    const fixture = await bootstrapFixture();
    const challenge = await start(fixture);
    const realAudit = new AdminAuditService(auditModel, TEST_ADMIN_POLICY);
    const recordSpy = jest.spyOn(audit, 'record');
    recordSpy
      .mockImplementationOnce((input: RecordAdminAuditInput) =>
        realAudit.record(input),
      )
      .mockRejectedValueOnce(new Error('simulated second audit failure'));

    await expect(complete(fixture, challenge.secretBase32)).rejects.toThrow(
      'simulated second audit failure',
    );
    recordSpy.mockRestore();

    const [account, state, sessions, activationAudits, mfaAudits] =
      await Promise.all([
        accountModel
          .findOne({ publicId: fixture.adminPublicId })
          .select('+activationGrantHash +pendingEncryptedTotpSecret')
          .lean()
          .exec(),
        stateModel
          .findOne({ key: ADMIN_BOOTSTRAP_SINGLETON_KEY })
          .select('+consumedAt')
          .lean()
          .exec(),
        sessionModel.countDocuments({ adminPublicId: fixture.adminPublicId }),
        auditModel.countDocuments({
          action: AdminAuditAction.ACTIVATION_CONSUMED,
        }),
        auditModel.countDocuments({ action: AdminAuditAction.MFA_ENROLLED }),
      ]);
    expect(account?.status).toBe(AdminAccountStatus.PENDING_ACTIVATION);
    expect(account?.activationGrantHash).toBeDefined();
    expect(account?.pendingEncryptedTotpSecret).toBeDefined();
    expect(state?.consumedAt).toBeNull();
    expect(sessions).toBe(0);
    expect(activationAudits).toBe(0);
    expect(mfaAudits).toBe(0);

    await expect(complete(fixture, challenge.secretBase32)).resolves.toEqual(
      expect.objectContaining({ recoveryCodes: expect.any(Array) }),
    );
  });
});
