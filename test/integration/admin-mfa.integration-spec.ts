import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Connection, type Model } from 'mongoose';
import { AdminModule } from '../../src/modules/admin/admin.module';
import {
  ADMIN_SECRET_ENV_KEYS,
  ADMIN_SECRETS,
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
  AdminAuditActorType,
  AdminAuditAction,
  AdminAuditSource,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminMfaEnrollmentMode } from '../../src/modules/admin/constants/admin-mfa.constants';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { ADMIN_AUDIT_COLLECTION } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminMfaCryptoService } from '../../src/modules/admin/services/admin-mfa-crypto.service';
import { AdminMfaService } from '../../src/modules/admin/services/admin-mfa.service';
import { AdminSessionService } from '../../src/modules/admin/services/admin-session.service';
import { createAdminTotp } from '../../src/modules/admin/utils/admin-totp';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_mfa_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
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

jest.setTimeout(90_000);

describe('Admin MFA MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let sessionModel: Model<AdminSession>;
  let service: AdminMfaService;
  let crypto: AdminMfaCryptoService;
  let sessions: AdminSessionService;
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
      .compile();
    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(AdminAccount.name));
    sessionModel = moduleRef.get(getModelToken(AdminSession.name));
    service = moduleRef.get(AdminMfaService);
    crypto = moduleRef.get(AdminMfaCryptoService);
    sessions = moduleRef.get(AdminSessionService);
    audit = moduleRef.get(AdminAuditService);
  });

  beforeEach(async () => connection.db?.dropDatabase());

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

  it('enrolls MFA, returns recovery codes once and rejects TOTP replay', async () => {
    const account = await accountModel.create({
      email: 'mfa@betta.test',
      username: 'admin.mfa',
      displayName: 'Admin MFA',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.PENDING_ACTIVATION,
      activationGrantHash: 'a'.repeat(64),
      activationGrantExpiresAt: new Date(Date.now() + 900_000),
    });
    const actor = {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      permissionVersion: account.permissionVersion,
    } as const;
    const challenge = await service.beginEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      mode: AdminMfaEnrollmentMode.INITIAL_ENROLLMENT,
      accountLabel: account.email,
    });
    const pending = await accountModel
      .findById(account._id)
      .select('+pendingEncryptedTotpSecret')
      .lean<Pick<AdminAccount, 'pendingEncryptedTotpSecret'>>()
      .exec();
    if (!pending?.pendingEncryptedTotpSecret) {
      throw new Error('Thiếu pending TOTP test fixture');
    }
    const secret = crypto.decryptTotpSecret(
      pending.pendingEncryptedTotpSecret,
      account.publicId,
    );
    const step = Math.floor(Date.now() / 30_000);
    const token = createAdminTotp(secret, step, 6);
    await accountModel.updateOne(
      { _id: account._id },
      { $set: { pendingTotpEnrollmentExpiresAt: new Date(Date.now() - 1) } },
    );
    await expect(
      service.confirmEnrollment({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        token,
        auditActor: actor,
        auditSource: AdminAuditSource.SYSTEM,
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Mã xác thực không hợp lệ hoặc đã hết hạn',
    });
    await accountModel.updateOne(
      { _id: account._id },
      { $set: { pendingTotpEnrollmentExpiresAt: challenge.expiresAt } },
    );
    const recoveryCodes = await service.confirmEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      token,
      auditActor: actor,
      auditSource: AdminAuditSource.SYSTEM,
    });

    expect(recoveryCodes).toHaveLength(10);
    const stored = await accountModel
      .findById(account._id)
      .select(
        '+encryptedTotpSecret +pendingEncryptedTotpSecret +recoveryCodeHashes +totpLastUsedStep',
      )
      .lean<
        Pick<
          AdminAccount,
          | 'mfaStatus'
          | 'recoveryCodeHashes'
          | 'totpLastUsedStep'
          | 'pendingEncryptedTotpSecret'
        >
      >()
      .exec();
    expect(stored?.mfaStatus).toBe(AdminMfaStatus.ACTIVE);
    expect(stored?.recoveryCodeHashes).toContain(
      crypto.hashRecoveryCode(recoveryCodes[0]),
    );
    expect(stored?.totpLastUsedStep).toBe(step);
    expect(stored).not.toHaveProperty('pendingEncryptedTotpSecret');
    await expect(
      service.verifyTotp(account._id, account.publicId, token),
    ).resolves.toBe(false);

    const next = new Date((step + 1) * 30_000);
    const nextToken = createAdminTotp(secret, step + 1, 6);
    const totpResults = await Promise.all([
      service.verifyTotp(account._id, account.publicId, nextToken, next),
      service.verifyTotp(account._id, account.publicId, nextToken, next),
    ]);
    expect(totpResults.sort()).toEqual([false, true]);

    const results = await Promise.all([
      service.consumeRecoveryCode({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        recoveryCode: recoveryCodes[0],
        auditActor: actor,
        auditSource: AdminAuditSource.SYSTEM,
      }),
      service.consumeRecoveryCode({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        recoveryCode: recoveryCodes[0],
        auditActor: actor,
        auditSource: AdminAuditSource.SYSTEM,
      }),
    ]);
    expect(results.sort()).toEqual([false, true]);

    const repeatedConfirm = service.confirmEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      token,
      auditActor: actor,
      auditSource: AdminAuditSource.SYSTEM,
    });
    await expect(repeatedConfirm).rejects.toMatchObject({ status: 401 });
    const auditText = JSON.stringify(
      await connection.collection(ADMIN_AUDIT_COLLECTION).find({}).toArray(),
    );
    expect(auditText).not.toContain(challenge.secretBase32);
    expect(auditText).not.toContain(token);
    for (const recoveryCode of recoveryCodes) {
      expect(auditText).not.toContain(recoveryCode);
    }
    await expect(
      service.confirmEnrollment({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        token,
        auditActor: actor,
        auditSource: AdminAuditSource.SYSTEM,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires current-factor proof and rolls back a failed re-enrollment', async () => {
    const oldSecret = crypto.generateTotpSecret();
    const oldEnvelope = crypto.encryptTotpSecret(oldSecret, 'adm_23456789ABCD');
    const currentStep = Math.floor(Date.now() / 30_000);
    const account = await accountModel.create({
      publicId: 'adm_23456789ABCD',
      email: 'reenroll@betta.test',
      username: 'admin.reenroll',
      displayName: 'Admin Re-enroll',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: 'p'.repeat(60),
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: oldEnvelope,
      totpLastUsedStep: currentStep - 1,
      recoveryCodeHashes: [crypto.hashRecoveryCode('A'.repeat(22))],
      activationGrantConsumedAt: new Date(),
    });
    const actor = {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      permissionVersion: account.permissionVersion,
    } as const;
    const session = await connection.transaction((mongoSession) =>
      sessions.createSession(
        {
          _id: account._id,
          publicId: account.publicId,
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          credentialVersion: 0,
          authzVersion: 0,
          permissionVersion: 1,
        },
        { userAgent: 'Chrome on Windows' },
        mongoSession,
      ),
    );

    await expect(
      service.beginEnrollment({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        mode: AdminMfaEnrollmentMode.ACTIVE_REENROLLMENT,
        accountLabel: account.email,
      }),
    ).rejects.toMatchObject({ status: 401 });

    await service.beginEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      mode: AdminMfaEnrollmentMode.ACTIVE_REENROLLMENT,
      currentTotpToken: createAdminTotp(oldSecret, currentStep, 6),
      accountLabel: account.email,
    });
    const pending = await accountModel
      .findById(account._id)
      .select('+pendingEncryptedTotpSecret')
      .lean<Pick<AdminAccount, 'pendingEncryptedTotpSecret'>>()
      .exec();
    if (!pending?.pendingEncryptedTotpSecret) {
      throw new Error('Thiếu pending TOTP re-enrollment fixture');
    }
    const newSecret = crypto.decryptTotpSecret(
      pending.pendingEncryptedTotpSecret,
      account.publicId,
    );
    const newToken = createAdminTotp(newSecret, currentStep, 6);
    const auditSpy = jest
      .spyOn(audit, 'record')
      .mockImplementation(
        (input): Promise<string> =>
          input.action === AdminAuditAction.MFA_ENROLLED
            ? Promise.reject(new Error('audit unavailable'))
            : Promise.resolve('aaud_23456789ABCDEFGH'),
      );

    await expect(
      service.confirmEnrollment({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        token: newToken,
        auditActor: actor,
        auditSource: AdminAuditSource.SYSTEM,
      }),
    ).rejects.toThrow('audit unavailable');
    auditSpy.mockRestore();

    const rolledBack = await accountModel
      .findById(account._id)
      .select('+encryptedTotpSecret +credentialVersion')
      .lean<Pick<AdminAccount, 'encryptedTotpSecret' | 'credentialVersion'>>()
      .exec();
    expect(rolledBack).toMatchObject({
      encryptedTotpSecret: oldEnvelope,
      credentialVersion: 0,
    });
    await expect(
      sessionModel.exists({
        publicId: session.sessionPublicId,
        revokedAt: null,
      }),
    ).resolves.toBeTruthy();

    await service.confirmEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      token: newToken,
      auditActor: actor,
      auditSource: AdminAuditSource.SYSTEM,
    });
    const completed = await accountModel
      .findById(account._id)
      .select('+credentialVersion')
      .lean<Pick<AdminAccount, 'credentialVersion'>>()
      .exec();
    expect(completed?.credentialVersion).toBe(1);
    await expect(
      sessionModel.exists({
        publicId: session.sessionPublicId,
        revokedAt: null,
      }),
    ).resolves.toBeNull();
    await expect(
      service.verifyTotp(
        account._id,
        account.publicId,
        createAdminTotp(oldSecret, currentStep + 1, 6),
      ),
    ).resolves.toBe(false);
    await expect(
      service.verifyTotp(
        account._id,
        account.publicId,
        createAdminTotp(newSecret, currentStep + 1, 6),
      ),
    ).resolves.toBe(true);
  });
});
