import { ConfigModule } from '@nestjs/config';
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
import { type Connection, type Model, Types } from 'mongoose';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  ADMIN_REPORT_QUEUE_UNASSIGNED,
  AdminReportQueueSlaFilter,
  AdminReportQueueSort,
  AdminReportQueueType,
} from '../../src/modules/admin/constants/admin-report-queue.constants';
import { AdminReportTargetAvailability } from '../../src/modules/admin/interfaces/admin-report-queue.interface';
import { AdminReportQueueService } from '../../src/modules/admin/services/admin-report-queue.service';
import { Post } from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import {
  ADMIN_REPORT_QUEUE_CREATED_INDEX,
  ADMIN_REPORT_QUEUE_FILTERED_INDEX,
  ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_CREATED_INDEX,
  ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX,
  ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX,
  buildReportQueueMetadata,
  ReportQueuePriority,
} from '../../src/modules/reports/constants/report-queue.constants';
import { migrateReportQueueMetadata } from '../../src/modules/reports/migrations/report-queue-metadata.migration';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportSource,
  SystemReportStatus,
  SystemReportType,
} from '../../src/modules/reports/schemas/system-report.schema';
import { generateReportPublicId } from '../../src/modules/reports/utils/generate-report-public-id';
import { generateSystemReportPublicId } from '../../src/modules/reports/utils/generate-system-report-public-id';
import { User } from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_arq_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID()
  .replace(/-/gu, '')
  .slice(0, 8)}`;

const TEST_ADMIN_SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `report-queue-integration-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 91).toString('base64'),
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

describe('Admin report queue MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let reports: Model<Report>;
  let systemReports: Model<SystemReport>;
  let users: Model<User>;
  let posts: Model<Post>;
  let service: AdminReportQueueService;

  const userFixture = (index: number) => ({
    publicId: generateUserPublicId(),
    username: `queue_user_${String(index).padStart(4, '0')}`,
    fullname: `Queue User ${String(index)}`,
    phone: `08${String(index).padStart(8, '0')}`,
    email: `queue.user.${String(index)}@betta.test`,
    status: 'active',
    isDeleted: false,
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
      Buffer.byteLength(databaseName, 'utf8') > 38
    ) {
      throw new Error('Ten integration database khong an toan');
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
        }),
        MongooseModule.forRoot(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        OutboxModule,
        AdminModule,
      ],
    })
      .overrideProvider(ADMIN_SECRETS)
      .useValue(TEST_ADMIN_SECRETS)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    reports = moduleRef.get<Model<Report>>(getModelToken(Report.name));
    systemReports = moduleRef.get<Model<SystemReport>>(
      getModelToken(SystemReport.name),
    );
    users = moduleRef.get<Model<User>>(getModelToken(User.name));
    posts = moduleRef.get<Model<Post>>(getModelToken(Post.name));
    service = moduleRef.get(AdminReportQueueService);
    await Promise.all([
      reports.syncIndexes(),
      systemReports.syncIndexes(),
      users.syncIndexes(),
      posts.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      reports.collection.deleteMany({}),
      systemReports.collection.deleteMany({}),
      users.collection.deleteMany({}),
      posts.collection.deleteMany({}),
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

  it('creates queue metadata/indexes and never returns sensitive fields', async () => {
    const [user] = await users.create([userFixture(1)]);
    if (!user) throw new Error('Khong tao duoc User fixture');
    const [report, systemReport] = await Promise.all([
      reports.create({
        reporterId: user._id,
        targetType: ReportTargetType.USER,
        targetId: user._id,
        reasonGroup: ReportReasonGroup.IMPERSONATION,
        reasonDetail: 'internal reason detail',
        description: 'private user report description',
        targetSnapshot: {
          publicId: user.publicId,
          username: user.username,
        },
        adminNote: 'private admin note',
      }),
      systemReports.create({
        publicId: generateSystemReportPublicId(),
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        category: 'LOGIN_PROBLEM',
        encryptedContactEmail: 'asenc.v1.secret-contact',
        contactLookupHmac: 'secret-contact-hmac',
        encryptedAccountIdentifier: 'asenc.v1.secret-account',
        requestFingerprintHmac: 'secret-fingerprint',
        description: 'private access support description',
        descriptionHash: 'description-hash',
        dedupeKey: `access-support:${randomUUID()}`,
        evidenceImages: [
          { url: 'https://private.example/evidence', publicId: 'private-id' },
        ],
        adminNote: 'private system admin note',
      }),
    ]);

    expect(report.publicId).toMatch(/^rpt_/u);
    expect(report.triageDueAt).toBeInstanceOf(Date);
    expect(systemReport.triageDueAt).toBeInstanceOf(Date);

    const result = await service.list({
      page: 1,
      limit: 20,
      sort: AdminReportQueueSort.CREATED_AT_DESC,
    });
    const serialized = JSON.stringify(result);
    expect(result.items).toHaveLength(2);
    for (const forbidden of [
      user._id.toHexString(),
      'internal reason detail',
      'private user report description',
      'private admin note',
      'asenc.v1.secret-contact',
      'secret-contact-hmac',
      'asenc.v1.secret-account',
      'secret-fingerprint',
      'private access support description',
      'https://private.example/evidence',
      'private system admin note',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const [reportIndexes, systemIndexes] = await Promise.all([
      reports.collection.listIndexes().toArray(),
      systemReports.collection.listIndexes().toArray(),
    ]);
    expect(
      reportIndexes.map(({ name }: { name?: string }) => name ?? ''),
    ).toEqual(
      expect.arrayContaining([
        ADMIN_REPORT_QUEUE_CREATED_INDEX,
        ADMIN_REPORT_QUEUE_FILTERED_INDEX,
        ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX,
      ]),
    );
    expect(
      systemIndexes.map(({ name }: { name?: string }) => name ?? ''),
    ).toContain(ADMIN_SYSTEM_REPORT_QUEUE_CREATED_INDEX);
  });

  it('paginates 205 equal-timestamp records without duplicates or omissions', async () => {
    const [target] = await users.create([userFixture(2)]);
    if (!target) throw new Error('Khong tao duoc target');
    const shared = new Date('2026-08-24T00:00:00.000Z');
    const metadata = buildReportQueueMetadata(shared);
    const reportIds = Array.from({ length: 105 }, generateReportPublicId);
    const systemIds = Array.from({ length: 100 }, generateSystemReportPublicId);

    await Promise.all([
      reports.collection.insertMany(
        reportIds.map((publicId) => ({
          publicId,
          reporterId: target._id,
          targetType: ReportTargetType.USER,
          targetId: target._id,
          reasonGroup: ReportReasonGroup.IMPERSONATION,
          reasonDetail: 'queue integration',
          status: ReportStatus.PENDING,
          priority: ReportQueuePriority.STANDARD,
          assigneePublicId: null,
          assignedAt: null,
          triageDueAt: metadata.triageDueAt,
          decisionDueAt: metadata.decisionDueAt,
          targetSnapshot: {
            publicId: target.publicId,
            username: target.username,
          },
          version: 0,
          terminalAt: null,
          createdAt: shared,
          updatedAt: shared,
        })),
      ),
      systemReports.collection.insertMany(
        systemIds.map((publicId, index) => ({
          publicId,
          reporterId: null,
          source: SystemReportSource.AUTH_PUBLIC,
          reportType: SystemReportType.ACCOUNT_ACCESS,
          category: 'LOGIN_PROBLEM',
          description: 'queue integration access support',
          descriptionHash: `hash-${String(index)}`,
          dedupeKey: `queue-integration-${String(index)}`,
          status: SystemReportStatus.PENDING,
          priority: ReportQueuePriority.STANDARD,
          assigneePublicId: null,
          assignedAt: null,
          triageDueAt: metadata.triageDueAt,
          decisionDueAt: metadata.decisionDueAt,
          version: 0,
          terminalAt: null,
          createdAt: shared,
          updatedAt: shared,
        })),
      ),
    ]);

    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        service.list({
          page,
          limit: 100,
          sort: AdminReportQueueSort.CREATED_AT_DESC,
        }),
      ),
    );
    const actual = pages.flatMap((page) =>
      page.items.map((item) => item.publicId),
    );
    const expected = [...reportIds, ...systemIds].sort();

    expect(pages.map((page) => page.items.length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.pagination.hasMore)).toEqual([
      true,
      true,
      false,
    ]);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(205);
  });

  it('filters P0 breached unassigned reports and marks expired targets', async () => {
    const [author] = await users.create([userFixture(3)]);
    if (!author) throw new Error('Khong tao duoc author');
    const expiredAt = new Date(Date.now() - 60_000);
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: author._id,
      content: 'Expired post used by report queue integration',
      expireAt: expiredAt,
    });
    const now = new Date();
    await reports.create({
      reporterId: author._id,
      targetType: ReportTargetType.POST,
      targetId: post._id,
      reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
      reasonDetail: 'P0 queue integration',
      status: ReportStatus.PENDING,
      priority: ReportQueuePriority.P0,
      assigneePublicId: null,
      triageDueAt: new Date(now.getTime() - 1_000),
      decisionDueAt: new Date(now.getTime() + 60_000),
      targetSnapshot: {
        publicId: post.publicId,
        authorUsername: author.username,
        expireAt: expiredAt,
      },
    });

    const result = await service.list({
      page: 1,
      limit: 20,
      type: AdminReportQueueType.POST,
      priority: ReportQueuePriority.P0,
      assignee: ADMIN_REPORT_QUEUE_UNASSIGNED,
      sla: AdminReportQueueSlaFilter.BREACHED,
      sort: AdminReportQueueSort.TRIAGE_DUE_ASC,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: AdminReportQueueType.POST,
      priority: ReportQueuePriority.P0,
      target: {
        publicId: post.publicId,
        availability: AdminReportTargetAvailability.EXPIRED,
      },
      sla: { isBreached: true },
    });
  });

  it('backfills legacy records with dry-run and execute safety', async () => {
    const [target] = await users.create([userFixture(4)]);
    if (!target) throw new Error('Khong tao duoc target');
    const legacyReportId = new Types.ObjectId();
    const legacySystemId = new Types.ObjectId();
    const createdAt = new Date('2026-08-24T01:00:00.000Z');
    await Promise.all([
      reports.collection.insertOne({
        _id: legacyReportId,
        reporterId: target._id,
        targetType: ReportTargetType.USER,
        targetId: target._id,
        reasonGroup: ReportReasonGroup.IMPERSONATION,
        reasonDetail: 'legacy report',
        status: ReportStatus.PENDING,
        targetSnapshot: { username: target.username },
        createdAt,
        updatedAt: createdAt,
      } as never),
      systemReports.collection.insertOne({
        _id: legacySystemId,
        reporterId: target._id,
        source: SystemReportSource.USER_AUTHENTICATED,
        reportType: SystemReportType.SYSTEM_ISSUE,
        description: 'legacy system report',
        descriptionHash: 'legacy-hash',
        dedupeKey: 'legacy-system-report',
        status: SystemReportStatus.PENDING,
        createdAt,
        updatedAt: createdAt,
      } as never),
    ]);

    const collections = {
      reports: reports.collection as never,
      systemReports: systemReports.collection as never,
      users: users.collection as never,
    };
    const dryRun = await migrateReportQueueMetadata(collections, {
      execute: false,
      batchSize: 20,
      now: createdAt,
    });
    expect(dryRun).toMatchObject({
      reportsPlanned: 1,
      systemReportsPlanned: 1,
      updated: 0,
    });
    expect(
      await reports.collection.findOne({ _id: legacyReportId }),
    ).not.toHaveProperty('publicId');

    const executed = await migrateReportQueueMetadata(collections, {
      execute: true,
      batchSize: 20,
      now: createdAt,
    });
    expect(executed.updated).toBe(2);
    const migrated = await reports.collection.findOne({
      _id: legacyReportId,
    });
    expect(migrated).toMatchObject({
      priority: ReportQueuePriority.STANDARD,
      version: 0,
      targetSnapshot: {
        publicId: target.publicId,
        username: target.username,
      },
    });
    expect(migrated?.publicId).toMatch(/^rpt_/u);
    expect(migrated?.triageDueAt).toBeInstanceOf(Date);
  });

  it('serves representative queue scans through named indexes', async () => {
    const [target] = await users.create([userFixture(5)]);
    if (!target) throw new Error('Khong tao duoc target');
    const createdAt = new Date();
    const metadata = buildReportQueueMetadata(createdAt);
    await reports.collection.insertMany(
      Array.from({ length: 150 }, (_, index) => ({
        publicId: generateReportPublicId(),
        reporterId: target._id,
        targetType: ReportTargetType.USER,
        targetId: target._id,
        reasonGroup: ReportReasonGroup.IMPERSONATION,
        reasonDetail: 'index integration',
        status: ReportStatus.PENDING,
        priority: ReportQueuePriority.STANDARD,
        triageDueAt: metadata.triageDueAt,
        decisionDueAt: metadata.decisionDueAt,
        version: 0,
        createdAt: new Date(createdAt.getTime() + index),
        updatedAt: createdAt,
      })),
    );

    const plans = await Promise.all([
      reports.collection
        .find({})
        .sort({ createdAt: -1, publicId: 1 })
        .hint(ADMIN_REPORT_QUEUE_CREATED_INDEX)
        .limit(20)
        .explain('executionStats'),
      reports.collection
        .find({
          status: ReportStatus.PENDING,
          targetType: ReportTargetType.USER,
          priority: ReportQueuePriority.STANDARD,
        })
        .sort({ createdAt: -1, publicId: 1 })
        .hint(ADMIN_REPORT_QUEUE_FILTERED_INDEX)
        .limit(20)
        .explain('executionStats'),
      reports.collection
        .find({
          status: ReportStatus.PENDING,
          triageDueAt: { $lte: metadata.triageDueAt },
        })
        .sort({ triageDueAt: 1, publicId: 1 })
        .hint(ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX)
        .limit(20)
        .explain('executionStats'),

      reports.collection
        .find({})
        .sort({ triageDueAt: 1, publicId: 1 })
        .hint(ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX)
        .limit(20)
        .explain('executionStats'),

      reports.collection
        .find({})
        .sort({ decisionDueAt: 1, publicId: 1 })
        .hint(ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX)
        .limit(20)
        .explain('executionStats'),

      systemReports.collection
        .find({})
        .sort({ triageDueAt: 1, publicId: 1 })
        .hint(ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX)
        .limit(20)
        .explain('executionStats'),

      systemReports.collection
        .find({})
        .sort({ decisionDueAt: 1, publicId: 1 })
        .hint(ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX)
        .limit(20)
        .explain('executionStats'),
    ]);

    for (const [plan, indexName] of [
      [plans[0], ADMIN_REPORT_QUEUE_CREATED_INDEX],
      [plans[1], ADMIN_REPORT_QUEUE_FILTERED_INDEX],
      [plans[2], ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX],
      [plans[3], ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX],
      [plans[4], ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX],
      [plans[5], ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX],
      [plans[6], ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX],
    ] as const) {
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain(indexName);
      expect(serialized).not.toContain('COLLSCAN');
    }
  });
});
