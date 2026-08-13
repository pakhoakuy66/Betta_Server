import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
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
  ADMIN_AUTH_UNAVAILABLE_MESSAGE,
  ADMIN_INVALID_CREDENTIALS_MESSAGE,
} from '../../src/modules/admin/constants/admin-auth.constants';
import { AdminAuditAction } from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminLoginProtectionScope } from '../../src/modules/admin/constants/admin-login-protection.constants';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminLoginProtection } from '../../src/modules/admin/schemas/admin-login-protection.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuthService } from '../../src/modules/admin/services/admin-auth.service';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminLoginProtectionService } from '../../src/modules/admin/services/admin-login-protection.service';
import { AdminMfaCryptoService } from '../../src/modules/admin/services/admin-mfa-crypto.service';
import { createAdminTotp } from '../../src/modules/admin/utils/admin-totp';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_admin_auth_it_';
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

jest.setTimeout(120_000);

describe('Admin authentication MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let sessionModel: Model<AdminSession>;
  let auditModel: Model<AdminAuditEvent>;
  let protectionModel: Model<AdminLoginProtection>;
  let auth: AdminAuthService;
  let crypto: AdminMfaCryptoService;
  let protection: AdminLoginProtectionService;
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
      .useValue(TEST_ADMIN_SECRETS)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(AdminAccount.name));
    sessionModel = moduleRef.get(getModelToken(AdminSession.name));
    auditModel = moduleRef.get(getModelToken(AdminAuditEvent.name));
    protectionModel = moduleRef.get(getModelToken(AdminLoginProtection.name));
    auth = moduleRef.get(AdminAuthService);
    crypto = moduleRef.get(AdminMfaCryptoService);
    protection = moduleRef.get(AdminLoginProtectionService);
    audit = moduleRef.get(AdminAuditService);

    await Promise.all([
      accountModel.syncIndexes(),
      sessionModel.syncIndexes(),
      auditModel.syncIndexes(),
      protectionModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
      accountModel.deleteMany({}),
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

  const createActiveAccount = async (suffix: string) => {
    const secret = crypto.generateTotpSecret();
    const password = `Safe password ${suffix}!2026`;
    const passwordHash = await bcrypt.hash(password, 12);
    const currentStep = Math.floor(Date.now() / 30_000);
    const publicId = generateAdminPublicId();
    const account = await accountModel.create({
      publicId,
      email: `admin.${suffix}@betta.test`,
      username: `admin.${suffix}`,
      displayName: `Admin ${suffix}`,
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: crypto.encryptTotpSecret(secret, publicId),
      activationGrantConsumedAt: new Date(),
      totpLastUsedStep: currentStep - 2,
    });
    return { account, password, secret, currentStep };
  };

  const login = (
    fixture: Awaited<ReturnType<typeof createActiveAccount>>,
    step = fixture.currentStep,
  ) =>
    auth.login({
      email: fixture.account.email,
      password: fixture.password,
      totpToken: createAdminTotp(fixture.secret, step, 6),
      trustedClientIp: '203.0.113.10',
      userAgent: 'Chrome on Windows',
    });

  it('creates one session, clears account failures and returns no secrets', async () => {
    const fixture = await createActiveAccount('success');
    await protection.recordFailure({
      accountKey: fixture.account.email,
      trustedClientIp: '203.0.113.10',
    });

    const result = await login(fixture);

    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken.split('.')).toHaveLength(3);
    expect(result.admin.id).toBe(fixture.account.publicId);
    expect(JSON.stringify(result)).not.toMatch(
      /password|totp|recovery|credentialVersion|authzVersion|permissionVersion/i,
    );
    await expect(
      sessionModel.countDocuments({ adminAccountId: fixture.account._id }),
    ).resolves.toBe(1);
    await expect(
      protectionModel.countDocuments({
        scope: AdminLoginProtectionScope.ACCOUNT,
      }),
    ).resolves.toBe(0);
    await expect(
      protectionModel.countDocuments({
        scope: AdminLoginProtectionScope.IP,
      }),
    ).resolves.toBe(1);
    await expect(
      auditModel.countDocuments({
        action: {
          $in: [
            AdminAuditAction.SESSION_CREATED,
            AdminAuditAction.LOGIN_SUCCEEDED,
          ],
        },
      }),
    ).resolves.toBe(2);
  });

  it('returns generic denial for unknown and ineligible accounts', async () => {
    const fixture = await createActiveAccount('locked');
    await accountModel.updateOne(
      { _id: fixture.account._id },
      { $set: { status: AdminAccountStatus.LOCKED, lockedAt: new Date() } },
    );

    const unknown = auth.login({
      email: 'unknown@betta.test',
      password: fixture.password,
      totpToken: '000000',
      trustedClientIp: '203.0.113.11',
    });
    const locked = login(fixture);

    await expect(unknown).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });
    await expect(locked).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });
    await expect(sessionModel.countDocuments({})).resolves.toBe(0);
  });

  it('returns generic denial and records a failure for a known wrong password', async () => {
    const fixture = await createActiveAccount('wrong-password');

    await expect(
      auth.login({
        email: fixture.account.email,
        password: 'Definitely not the configured password',
        totpToken: createAdminTotp(fixture.secret, fixture.currentStep, 6),
        trustedClientIp: '203.0.113.12',
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });

    await expect(sessionModel.countDocuments({})).resolves.toBe(0);
    await expect(
      protectionModel.countDocuments({
        scope: AdminLoginProtectionScope.ACCOUNT,
      }),
    ).resolves.toBe(1);
  });

  it.each([
    {
      label: 'must-change-password account',
      suffix: 'must-change',
      update: { $set: { mustChangePassword: true } },
    },
    {
      label: 'MFA-inactive account',
      suffix: 'mfa-inactive',
      update: { $set: { mfaStatus: AdminMfaStatus.RESET_REQUIRED } },
    },
    {
      label: 'soft-deleted account',
      suffix: 'soft-deleted',
      update: {
        $set: {
          status: AdminAccountStatus.SOFT_DELETED,
          deletedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      },
    },
  ])('returns generic denial for a $label', async ({ suffix, update }) => {
    const fixture = await createActiveAccount(suffix);
    await accountModel.updateOne({ _id: fixture.account._id }, update);

    await expect(login(fixture)).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });
    await expect(
      sessionModel.countDocuments({ adminAccountId: fixture.account._id }),
    ).resolves.toBe(0);
  });

  it('maps a MongoDB outage to sanitized 503 without creating a session', async () => {
    const outage = Object.assign(
      new Error('mongodb://user:password@internal-host/admin'),
      { name: 'MongoNetworkError' },
    );
    jest.spyOn(accountModel, 'findOne').mockImplementationOnce(() => {
      throw outage;
    });

    await expect(
      auth.login({
        email: 'outage@betta.test',
        password: 'Safe password outage!2026',
        totpToken: '123456',
        trustedClientIp: '203.0.113.13',
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: ADMIN_AUTH_UNAVAILABLE_MESSAGE,
    });
    await expect(sessionModel.countDocuments({})).resolves.toBe(0);
  });

  it('allows only one concurrent winner for the same TOTP step', async () => {
    const fixture = await createActiveAccount('concurrent');
    const results = await Promise.allSettled([login(fixture), login(fixture)]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(sessionModel.countDocuments({})).resolves.toBe(1);
  });

  it('rotates refresh, detects old-token replay and revokes the family', async () => {
    const fixture = await createActiveAccount('refresh');
    const signedIn = await login(fixture);
    const rotated = await auth.refresh(signedIn.refreshToken);

    expect(rotated.refreshToken).not.toBe(signedIn.refreshToken);
    await expect(auth.refresh(signedIn.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('logs out the current session idempotently', async () => {
    const fixture = await createActiveAccount('logout');
    const signedIn = await login(fixture);
    const account = await accountModel
      .findById(fixture.account._id)
      .select(
        '_id publicId username displayName role +credentialVersion ' +
          '+authzVersion +permissionVersion',
      )
      .lean()
      .exec();
    if (!account) throw new Error('Missing account fixture');

    await expect(auth.logout(account, signedIn.sessionPublicId)).resolves.toBe(
      true,
    );
    await expect(auth.logout(account, signedIn.sessionPublicId)).resolves.toBe(
      false,
    );
    await expect(auth.refresh(signedIn.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rolls back TOTP replay state and session when login audit fails', async () => {
    const fixture = await createActiveAccount('rollback');
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('Injected audit failure'));

    await expect(login(fixture)).rejects.toThrow('Injected audit failure');

    const stored = await accountModel
      .findById(fixture.account._id)
      .select('+totpLastUsedStep')
      .lean<Pick<AdminAccount, 'totpLastUsedStep'>>()
      .exec();
    expect(stored?.totpLastUsedStep).toBe(fixture.currentStep - 2);
    await expect(sessionModel.countDocuments({})).resolves.toBe(0);
    await expect(
      auditModel.countDocuments({
        action: {
          $in: [
            AdminAuditAction.SESSION_CREATED,
            AdminAuditAction.LOGIN_SUCCEEDED,
          ],
        },
      }),
    ).resolves.toBe(0);
  });
});
