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
  ADMIN_ACCOUNT_COLLECTION,
  ADMIN_ACCOUNT_EMAIL_INDEX,
  ADMIN_ACCOUNT_LIST_INDEX,
  ADMIN_ACCOUNT_PUBLIC_ID_INDEX,
  ADMIN_ACCOUNT_USERNAME_INDEX,
  AdminAccount,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/schemas/admin-account.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_admin_account_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const HIDDEN_FIELDS = [
  'passwordHash',
  'credentialVersion',
  'authzVersion',
  'permissionVersion',
  'version',
  'encryptedTotpSecret',
  'totpLastUsedStep',
  'recoveryCodeHashes',
  'activationGrantHash',
  'activationGrantExpiresAt',
  'activationGrantConsumedAt',
] as const;

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
  source: {
    get: (key: string): unknown => TEST_ADMIN_SECRET_VALUES[key],
  },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});

jest.setTimeout(90_000);

describe('AdminAccount MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let adminModel: Model<AdminAccount>;

  const createSource = (suffix: string) => ({
    email: `admin.${suffix}@betta.test`,
    username: `admin.${suffix}`,
    displayName: `Admin ${suffix}`,
    role: AdminRole.ADMIN,
    activationGrantHash: 'a'.repeat(64),
    activationGrantExpiresAt: new Date(Date.now() + 15 * 60_000),
  });

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
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Tên integration database không an toàn');
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
    adminModel = moduleRef.get<Model<AdminAccount>>(
      getModelToken(AdminAccount.name),
    );
    await adminModel.syncIndexes();
  });

  beforeEach(async () => {
    await adminModel.collection.deleteMany({});
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

  it('resolves the model through AdminModule dependency injection', () => {
    expect(adminModel.modelName).toBe(AdminAccount.name);
    expect(adminModel.collection.collectionName).toBe(ADMIN_ACCOUNT_COLLECTION);
  });

  it('creates approved indexes and no TTL index', async () => {
    const indexes = (await adminModel.collection
      .listIndexes()
      .toArray()) as Array<{
      name?: string;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    const names = indexes.map((index) => index.name);

    expect(names).toEqual(
      expect.arrayContaining([
        '_id_',
        ADMIN_ACCOUNT_PUBLIC_ID_INDEX,
        ADMIN_ACCOUNT_EMAIL_INDEX,
        ADMIN_ACCOUNT_USERNAME_INDEX,
        ADMIN_ACCOUNT_LIST_INDEX,
      ]),
    );
    expect(
      indexes.filter((index) => index.unique).map((index) => index.name),
    ).toEqual(
      expect.arrayContaining([
        ADMIN_ACCOUNT_PUBLIC_ID_INDEX,
        ADMIN_ACCOUNT_EMAIL_INDEX,
        ADMIN_ACCOUNT_USERNAME_INDEX,
      ]),
    );
    expect(
      indexes.every((index) => index.expireAfterSeconds === undefined),
    ).toBe(true);
  });

  it('hides sensitive fields unless explicitly selected', async () => {
    const created = await adminModel.create({
      ...createSource('hidden'),
      passwordHash: 'p'.repeat(60),
      encryptedTotpSecret: 'ciphertext',
      recoveryCodeHashes: ['r'.repeat(64)],
    });

    const hidden = await adminModel.findById(created._id).lean().exec();
    for (const field of HIDDEN_FIELDS) expect(hidden).not.toHaveProperty(field);

    const explicit = await adminModel
      .findById(created._id)
      .select(HIDDEN_FIELDS.map((field) => `+${field}`).join(' '))
      .lean()
      .exec();

    expect(explicit).toMatchObject({
      passwordHash: 'p'.repeat(60),
      encryptedTotpSecret: 'ciphertext',
      recoveryCodeHashes: ['r'.repeat(64)],
      authzVersion: 0,
      credentialVersion: 0,
      permissionVersion: 1,
    });
  });

  it.each(['email', 'username', 'publicId'] as const)(
    'enforces unique %s in MongoDB',
    async (field) => {
      const first = await adminModel.create(createSource(field));
      const duplicate = {
        ...createSource(`${field}2`),
        [field]: first[field],
      };

      await expect(adminModel.create(duplicate)).rejects.toMatchObject({
        code: 11000,
      });
      await expect(adminModel.countDocuments({})).resolves.toBe(1);
    },
  );

  it.each([
    ['email', ' ADMIN@BETTA.TEST ', 'admin@betta.test'],
    ['username', ' Admin.Owner ', 'admin.owner'],
  ] as const)(
    'normalizes %s before enforcing uniqueness',
    async (field, firstValue, duplicateValue) => {
      await adminModel.create({
        ...createSource(`normalized-${field}`),
        [field]: firstValue,
      });

      await expect(
        adminModel.create({
          ...createSource(`duplicate-${field}`),
          [field]: duplicateValue,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    },
  );

  it('rejects active state that retains activation credentials', async () => {
    await expect(
      adminModel.create({
        ...createSource('invalid-active'),
        status: AdminAccountStatus.ACTIVE,
        passwordHash: 'p'.repeat(60),
        mustChangePassword: false,
        mfaStatus: AdminMfaStatus.ACTIVE,
        encryptedTotpSecret: 'ciphertext',
        activationGrantConsumedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      errors: { activationGrantConsumedAt: expect.anything() },
    });
  });

  it('rejects unknown fields under strict throw mode', () => {
    expect(
      () =>
        new adminModel({
          ...createSource('strict'),
          permissions: ['*'],
          refreshToken: 'must-not-be-stored',
        }),
    ).toThrow();
  });
});
