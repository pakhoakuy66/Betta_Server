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
import { AdminModule } from '../../src/modules/admin/admin.module';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  ADMIN_ACCOUNT_GLOBAL_LIST_INDEX,
  ADMIN_ACCOUNT_LIST_INDEX,
  AdminAccount,
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccountQueryService } from '../../src/modules/admin/services/admin-account-query.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const MONGODB_DATABASE_NAME_MAX_BYTES = 38;
const DATABASE_PREFIX = 'betta_aaq_it_';

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const TEST_ADMIN_SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `account-query-integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 31).toString('base64'),
      },
      previous: [],
    }),
  ]),
) as Readonly<Record<string, string>>;

const TEST_ADMIN_SECRETS = createAdminSecrets({
  source: {
    get: (key: string): unknown => TEST_ADMIN_SECRET_VALUES[key],
  },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});

const ACTIVE_IDS = [
  'adm_23456789ABCD',
  'adm_3456789ABCDE',
  'adm_456789ABCDEF',
] as const;

jest.setTimeout(90_000);

describe('Admin account query MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<AdminAccount>;
  let sessionModel: Model<AdminSession>;
  let service: AdminAccountQueryService;

  const activeAccount = (index: number, role = AdminRole.ADMIN) => ({
    publicId: ACTIVE_IDS[index],
    email: `admin.${String(index + 1)}@betta.test`,
    username: `admin.${String(index + 1)}`,
    displayName: `Admin ${String(index + 1)}`,
    role,
    status: AdminAccountStatus.ACTIVE,
    passwordHash: `$2b$12$${'a'.repeat(53)}`,
    mustChangePassword: false,
    version: 4,
    mfaStatus: AdminMfaStatus.ACTIVE,
    encryptedTotpSecret: `atotp_v1.integration.${String(index + 1)}`,
    activationGrantConsumedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

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
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Ten integration database khong an toan');
    }

    if (
      Buffer.byteLength(databaseName, 'utf8') > MONGODB_DATABASE_NAME_MAX_BYTES
    ) {
      throw new Error('Ten integration database vuot gioi han MongoDB');
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
    accountModel = moduleRef.get<Model<AdminAccount>>(
      getModelToken(AdminAccount.name),
    );
    sessionModel = moduleRef.get<Model<AdminSession>>(
      getModelToken(AdminSession.name),
    );
    service = moduleRef.get(AdminAccountQueryService);
    await Promise.all([accountModel.syncIndexes(), sessionModel.syncIndexes()]);
  });

  beforeEach(async () => {
    await Promise.all([
      accountModel.collection.deleteMany({}),
      sessionModel.collection.deleteMany({}),
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

  it('creates indexes for filtered and global stable list queries', async () => {
    const indexes = await accountModel.collection.listIndexes().toArray();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: ADMIN_ACCOUNT_LIST_INDEX,
          key: { status: 1, role: 1, createdAt: -1, publicId: 1 },
        }),
        expect.objectContaining({
          name: ADMIN_ACCOUNT_GLOBAL_LIST_INDEX,
          key: { createdAt: -1, publicId: 1 },
        }),
      ]),
    );
  });

  it('filters exact normalized identity and exposes only the public contract', async () => {
    await accountModel.create([
      activeAccount(0),
      activeAccount(1, AdminRole.SUPER_ADMIN),
      {
        publicId: 'adm_56789ABCDEFG',
        email: 'deleted.admin@betta.test',
        username: 'deleted.admin',
        displayName: 'Deleted Admin',
        role: AdminRole.ADMIN,
        status: AdminAccountStatus.SOFT_DELETED,
        mfaStatus: AdminMfaStatus.RESET_REQUIRED,
        passwordHash: `$2b$12$${'a'.repeat(53)}`,
        mustChangePassword: false,
        activationGrantConsumedAt: new Date('2026-08-01T00:00:00.000Z'),
        deletedAt: new Date('2026-08-11T00:00:00.000Z'),
        deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
      },
    ]);

    const result = await service.list({
      page: 1,
      limit: 20,
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      search: '  ADMIN.2@BETTA.TEST  ',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.publicId).toBe(ACTIVE_IDS[1]);
    expect(result.items[0]?.version).toBe(4);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      '_id',
      'passwordHash',
      'encryptedTotpSecret',
      'activationGrantHash',
      'recoveryCodeHashes',
      'credentialVersion',
      'authzVersion',
      'permissionVersion',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('paginates equal timestamps without duplicates or omissions', async () => {
    await accountModel.create(
      ACTIVE_IDS.map((_, index) => activeAccount(index)),
    );
    const sharedCreatedAt = new Date('2026-08-10T00:00:00.000Z');
    await accountModel.collection.updateMany(
      {},
      { $set: { createdAt: sharedCreatedAt } },
    );

    const first = await service.list({ page: 1, limit: 2 });
    const second = await service.list({ page: 2, limit: 2 });
    const ids = [...first.items, ...second.items].map((item) => item.publicId);

    expect(first.pagination.hasMore).toBe(true);
    expect(second.pagination.hasMore).toBe(false);
    expect(ids).toEqual([...ACTIVE_IDS].sort());
    expect(new Set(ids).size).toBe(ACTIVE_IDS.length);
  });

  it('summarizes only active unexpired sessions in one account result', async () => {
    const [stored] = await accountModel.create([activeAccount(0)]);
    if (!stored) throw new Error('Khong tao duoc fixture AdminAccount');
    const now = Date.now();
    const session = (
      suffix: string,
      expiresAt: Date,
      revokedAt: Date | null,
      lastUsedAt: Date,
    ) => ({
      adminAccountId: stored._id,
      adminPublicId: stored.publicId,
      publicId: `ases_${suffix.padEnd(16, 'A')}`,
      tokenFamily: `afam_${suffix.padEnd(16, 'B')}`,
      refreshTokenHash: `sha256-v1:${suffix.padEnd(64, 'c')}`,
      deviceLabel: suffix,
      lastUsedAt,
      expiresAt,
      revokedAt,
    });
    await sessionModel.create([
      session(
        'active1',
        new Date(now + 60_000),
        null,
        new Date('2026-08-12T01:00:00.000Z'),
      ),
      session(
        'active2',
        new Date(now + 60_000),
        null,
        new Date('2026-08-12T02:00:00.000Z'),
      ),
      session(
        'revoked',
        new Date(now + 60_000),
        new Date(now),
        new Date('2026-08-12T03:00:00.000Z'),
      ),
      session(
        'expired',
        new Date(now - 60_000),
        null,
        new Date('2026-08-12T04:00:00.000Z'),
      ),
    ]);

    const detail = await service.detail(stored.publicId);

    expect(detail.sessionSummary).toEqual({
      activeCount: 2,
      lastActiveAt: '2026-08-12T02:00:00.000Z',
    });
  });

  it('returns a soft-deleted account by public ID and 404 for unknown IDs', async () => {
    await accountModel.create({
      publicId: 'adm_6789ABCDEFGH',
      email: 'deleted.detail@betta.test',
      username: 'deleted.detail',
      displayName: 'Deleted Detail',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.SOFT_DELETED,
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      passwordHash: `$2b$12$${'b'.repeat(53)}`,
      mustChangePassword: false,
      activationGrantConsumedAt: new Date('2026-08-01T00:00:00.000Z'),
      deletedAt: new Date('2026-08-11T05:00:00.000Z'),
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
    });

    await expect(service.detail('adm_6789ABCDEFGH')).resolves.toMatchObject({
      publicId: 'adm_6789ABCDEFGH',
      status: AdminAccountStatus.SOFT_DELETED,
      deletedAt: '2026-08-11T05:00:00.000Z',
    });
    await expect(service.detail('adm_789ABCDEFGHJ')).rejects.toMatchObject({
      status: 404,
    });
  });
});
