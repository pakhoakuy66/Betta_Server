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
  AdminUserLoginLockFilter,
  AdminUserRestrictionFilter,
  AdminUserSort,
} from '../../src/modules/admin/constants/admin-user-query.constants';
import { AdminUserQueryService } from '../../src/modules/admin/services/admin-user-query.service';
import { AuthSession } from '../../src/modules/auth/schemas/auth-session.schema';
import {
  ADMIN_USER_REPORT_COUNT_INDEX,
  Report,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import {
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
  AdminAuditActorType,
  AdminAuditSource,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { generateAdminAuditPublicId } from '../../src/modules/admin/utils/generate-admin-audit-public-id';
import {
  UserDeletionOrigin,
  UserRestrictionType,
} from '../../src/modules/users/constants/user-moderation.constants';
import {
  ADMIN_USER_FILTERED_LIST_INDEX,
  ADMIN_USER_GLOBAL_LIST_INDEX,
  ADMIN_USER_LOGIN_LOCK_LIST_INDEX,
  ADMIN_USER_RESTRICTION_LIST_INDEX,
  ADMIN_USER_USERNAME_LIST_INDEX,
  USER_STATUS,
  User,
} from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_auq_it_';
const DATABASE_NAME_MAX_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const TEST_ADMIN_SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `user-query-integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 71).toString('base64'),
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

describe('Admin User query MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let userModel: Model<User>;
  let sessionModel: Model<AuthSession>;
  let reportModel: Model<Report>;
  let auditEventModel: Model<AdminAuditEvent>;
  let service: AdminUserQueryService;

  const fixture = (index: number, overrides: Record<string, unknown> = {}) => ({
    publicId: generateUserPublicId(),
    username: `query_user_${String(index).padStart(4, '0')}`,
    fullname: `Query User ${String(index)}`,
    phone: `09${String(index).padStart(8, '0')}`,
    email: `query.user.${String(index)}@betta.test`,
    avatar: `https://cdn.example/${String(index)}.webp`,
    status: USER_STATUS.ACTIVE,
    isDeleted: false,
    ...overrides,
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
    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > DATABASE_NAME_MAX_BYTES
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
      .useValue(TEST_ADMIN_SECRETS)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    userModel = moduleRef.get<Model<User>>(getModelToken(User.name));
    sessionModel = moduleRef.get<Model<AuthSession>>(
      getModelToken(AuthSession.name),
    );
    reportModel = moduleRef.get<Model<Report>>(getModelToken(Report.name));
    auditEventModel = moduleRef.get<Model<AdminAuditEvent>>(
      getModelToken(AdminAuditEvent.name),
    );
    service = moduleRef.get(AdminUserQueryService);
    await Promise.all([
      userModel.syncIndexes(),
      sessionModel.syncIndexes(),
      reportModel.syncIndexes(),
      auditEventModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      userModel.collection.deleteMany({}),
      sessionModel.collection.deleteMany({}),
      reportModel.collection.deleteMany({}),
      auditEventModel.collection.deleteMany({}),
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

  it('creates indexes for stable and filtered management queries', async () => {
    const indexes = await userModel.collection.listIndexes().toArray();
    const reportIndexes = await reportModel.collection.listIndexes().toArray();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: ADMIN_USER_GLOBAL_LIST_INDEX,
          key: { createdAt: -1, publicId: 1 },
        }),
        expect.objectContaining({
          name: ADMIN_USER_FILTERED_LIST_INDEX,
          key: { isDeleted: 1, status: 1, createdAt: -1, publicId: 1 },
        }),
        expect.objectContaining({ name: ADMIN_USER_LOGIN_LOCK_LIST_INDEX }),
        expect.objectContaining({ name: ADMIN_USER_RESTRICTION_LIST_INDEX }),
        expect.objectContaining({
          name: ADMIN_USER_USERNAME_LIST_INDEX,
          key: { username: 1, publicId: 1 },
        }),
      ]),
    );
    expect(reportIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: ADMIN_USER_REPORT_COUNT_INDEX,
          key: { targetType: 1, targetId: 1 },
        }),
      ]),
    );
  });

  it('normalizes exact identity and keeps login lock separate from restriction', async () => {
    const [restricted, loginLocked] = await userModel.create([
      fixture(1, {
        restriction: {
          type: UserRestrictionType.TEMPORARY_SUSPENSION,
          effectiveAt: new Date('2026-08-15T00:00:00.000Z'),
          expiresAt: new Date('2026-08-16T00:00:00.000Z'),
          supportReference: 'sup_12345678',
          publicReasonCode: 'policy.violation',
        },
      }),
      fixture(2, { lockedUntil: new Date(Date.now() + 60_000) }),
    ]);

    const byEmail = await service.list({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
      search: '  QUERY.USER.1@BETTA.TEST  ',
    });
    const byPhone = await service.list({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
      search: '0900000002',
    });
    const restriction = await service.list({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
      restriction: AdminUserRestrictionFilter.TEMPORARY_SUSPENSION,
      loginLock: AdminUserLoginLockFilter.UNLOCKED,
    });
    const lock = await service.list({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
      restriction: AdminUserRestrictionFilter.NONE,
      loginLock: AdminUserLoginLockFilter.LOCKED,
    });

    expect(byEmail.items.map((item) => item.publicId)).toEqual([
      restricted.publicId,
    ]);
    expect(byPhone.items.map((item) => item.publicId)).toEqual([
      loginLocked.publicId,
    ]);
    expect(restriction.items.map((item) => item.publicId)).toEqual([
      restricted.publicId,
    ]);
    expect(lock.items.map((item) => item.publicId)).toEqual([
      loginLocked.publicId,
    ]);
  });

  it('masks contact and never exposes credentials or cleanup internals', async () => {
    const [stored] = await userModel.create([
      fixture(3, {
        password: '$2b$12$secret-hash',
        refreshToken: 'secret-refresh-hash',
        forgotPasswordOtp: '123456',
        authzVersion: 9,
        moderationMigration: {
          version: 1,
          migratedAt: new Date(),
          ownedFields: [
            'isDeleted',
            'restriction',
            'deletionOrigin',
            'restorableUntil',
            'version',
            'authzVersion',
            'moderationSchemaVersion',
          ],
        },
      }),
    ]);
    if (!stored) throw new Error('Khong tao duoc User fixture');

    const result = await service.detail(stored.publicId);
    const serialized = JSON.stringify(result);

    expect(result.contact).toEqual({
      email: 'q***@betta.test',
      phone: '******0003',
    });
    for (const forbidden of [
      stored._id.toHexString(),
      'query.user.3@betta.test',
      '0900000003',
      'secret-hash',
      'secret-refresh-hash',
      'forgotPasswordOtp',
      'authzVersion',
      'moderationMigration',
      'oauth',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('paginates a large equal-timestamp dataset without duplicates or omissions', async () => {
    const fixtures = Array.from({ length: 205 }, (_, index) =>
      fixture(index + 10),
    );
    await userModel.insertMany(fixtures);
    const sharedCreatedAt = new Date('2026-08-15T00:00:00.000Z');
    await userModel.collection.updateMany(
      {},
      { $set: { createdAt: sharedCreatedAt } },
    );

    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        service.list({
          page,
          limit: 100,
          sort: AdminUserSort.CREATED_AT_DESC,
        }),
      ),
    );
    const actual = pages.flatMap((page) =>
      page.items.map((item) => item.publicId),
    );
    const expected = fixtures.map((item) => item.publicId).sort();

    expect(pages.map((page) => page.items.length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.pagination.hasMore)).toEqual([
      true,
      true,
      false,
    ]);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(205);
  });

  it('summarizes only active unexpired sessions in detail', async () => {
    const [stored] = await userModel.create([fixture(4)]);
    if (!stored) throw new Error('Khong tao duoc User fixture');
    const now = Date.now();
    const session = (
      suffix: string,
      expiresAt: Date,
      revokedAt: Date | null,
      lastUsedAt: Date,
    ) => ({
      userId: stored._id,
      publicId: `ses_${suffix.padEnd(16, 'A')}`,
      tokenFamily: `fam_${suffix.padEnd(16, 'B')}`,
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${suffix.padEnd(64, 'c')}`,
      deviceLabel: suffix,
      lastUsedAt,
      expiresAt,
      revokedAt,
    });
    await sessionModel.create([
      session(
        'active',
        new Date(now + 60_000),
        null,
        new Date('2026-08-15T02:00:00.000Z'),
      ),
      session(
        'revoked',
        new Date(now + 60_000),
        new Date(now),
        new Date('2026-08-15T03:00:00.000Z'),
      ),
      session(
        'expired',
        new Date(now - 60_000),
        null,
        new Date('2026-08-15T04:00:00.000Z'),
      ),
    ]);
    await reportModel.collection.insertMany([
      {
        reporterId: stored._id,
        targetType: ReportTargetType.USER,
        targetId: stored._id,
        reasonGroup: 'violation_content',
        reasonDetail: 'integration report one',
        status: 'pending',
      },
      {
        reporterId: stored._id,
        targetType: ReportTargetType.USER,
        targetId: stored._id,
        reasonGroup: 'impersonation',
        reasonDetail: 'integration report two',
        status: 'resolved',
      },
    ]);
    await auditEventModel.collection.insertMany([
      {
        publicId: generateAdminAuditPublicId(),
        schemaVersion: 1,
        action: AdminAuditAction.USER_SUSPENDED,
        outcome: AdminAuditOutcome.SUCCEEDED,
        actor: {
          type: AdminAuditActorType.SYSTEM,
          displayName: 'Integration test',
        },
        target: {
          type: AdminAuditTargetType.USER,
          publicId: stored.publicId,
        },
        reasonCode: 'policy_violation',
        source: AdminAuditSource.SYSTEM,
        expiresAt: new Date(Date.now() + 60_000),
        occurredAt: new Date(),
      },
      {
        publicId: generateAdminAuditPublicId(),
        schemaVersion: 1,
        action: AdminAuditAction.USER_BANNED,
        outcome: AdminAuditOutcome.DENIED,
        actor: {
          type: AdminAuditActorType.SYSTEM,
          displayName: 'Integration test',
        },
        target: {
          type: AdminAuditTargetType.USER,
          publicId: stored.publicId,
        },
        reasonCode: 'denied_action_is_not_counted',
        source: AdminAuditSource.SYSTEM,
        expiresAt: new Date(Date.now() + 60_000),
        occurredAt: new Date(),
      },
    ]);

    await expect(service.detail(stored.publicId)).resolves.toMatchObject({
      publicId: stored.publicId,
      sessionSummary: {
        activeCount: 1,
        lastActiveAt: '2026-08-15T02:00:00.000Z',
      },
      activitySummary: {
        reportCount: 2,
        moderationActionCount: 1,
      },
    });
  });

  it('serves representative list and count operations through named indexes', async () => {
    await userModel.insertMany(
      Array.from({ length: 205 }, (_, index) =>
        fixture(index + 500, {
          lockedUntil: index % 2 === 0 ? new Date(Date.now() + 60_000) : null,
          restriction:
            index % 3 === 0
              ? {
                  type: UserRestrictionType.TEMPORARY_SUSPENSION,
                  effectiveAt: new Date(),
                  expiresAt: new Date(Date.now() + 60_000),
                  supportReference: `sup_${String(index).padStart(8, '0')}`,
                  publicReasonCode: 'policy.violation',
                }
              : null,
        }),
      ),
    );

    const explainWithIndex = async (
      filter: Record<string, unknown>,
      sort: Record<string, 1 | -1>,
      indexName: string,
    ) =>
      userModel.collection
        .find(filter)
        .sort(sort)
        .hint(indexName)
        .limit(20)
        .explain('executionStats');

    const plans = await Promise.all([
      explainWithIndex(
        {},
        { createdAt: -1, publicId: 1 },
        ADMIN_USER_GLOBAL_LIST_INDEX,
      ),
      explainWithIndex(
        { isDeleted: false, status: USER_STATUS.ACTIVE },
        { createdAt: -1, publicId: 1 },
        ADMIN_USER_FILTERED_LIST_INDEX,
      ),
      explainWithIndex(
        {},
        { username: 1, publicId: 1 },
        ADMIN_USER_USERNAME_LIST_INDEX,
      ),
      explainWithIndex(
        { 'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION },
        { createdAt: -1, publicId: 1 },
        ADMIN_USER_RESTRICTION_LIST_INDEX,
      ),
      explainWithIndex(
        { lockedUntil: { $gt: new Date() } },
        { createdAt: -1, publicId: 1 },
        ADMIN_USER_LOGIN_LOCK_LIST_INDEX,
      ),
    ]);
    const reportPlan = await reportModel.collection
      .find({ targetType: ReportTargetType.USER })
      .hint(ADMIN_USER_REPORT_COUNT_INDEX)
      .explain('executionStats');

    for (const [plan, indexName] of [
      [plans[0], ADMIN_USER_GLOBAL_LIST_INDEX],
      [plans[1], ADMIN_USER_FILTERED_LIST_INDEX],
      [plans[2], ADMIN_USER_USERNAME_LIST_INDEX],
      [plans[3], ADMIN_USER_RESTRICTION_LIST_INDEX],
      [plans[4], ADMIN_USER_LOGIN_LOCK_LIST_INDEX],
      [reportPlan, ADMIN_USER_REPORT_COUNT_INDEX],
    ] as const) {
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain(indexName);
      expect(serialized).not.toContain('COLLSCAN');
    }
  });

  it('returns deleted users by public ID and rejects IDOR identifiers', async () => {
    const [stored] = await userModel.create([
      fixture(5, {
        isDeleted: true,
        deletedAt: new Date('2026-08-15T05:00:00.000Z'),
        deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
      }),
    ]);
    if (!stored) throw new Error('Khong tao duoc User fixture');

    await expect(service.detail(stored.publicId)).resolves.toMatchObject({
      deletion: {
        isDeleted: true,
        origin: UserDeletionOrigin.ADMIN_MODERATION,
      },
    });
    await expect(
      service.detail(stored._id.toHexString()),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.detail(generateUserPublicId())).rejects.toMatchObject({
      status: 404,
    });
  });
});
