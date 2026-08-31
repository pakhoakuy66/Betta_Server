import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { randomUUID } from 'node:crypto';
import { type Connection, type Model, Types } from 'mongoose';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
import {
  REPORT_ASSIGNMENT_CONFLICT_ERROR,
  REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT_ERROR,
} from '../../src/common/security/public-report-assignment-conflict';
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
import { AdminReportQueueStatus } from '../../src/modules/admin/constants/admin-report-queue.constants';
import {
  AdminReportAssignmentKind,
  AdminReportAssignmentOperation,
  AdminReportAssignmentRequestState,
} from '../../src/modules/admin/constants/admin-report-assignment.constants';
import {
  AdminReportAssignmentConflictException,
  AdminReportAssignmentIdempotencyConflictException,
} from '../../src/modules/admin/exceptions/admin-report-assignment-conflict.exception';
import type {
  AdminReportAssignmentActor,
  UpdateAdminReportAssignmentInput,
} from '../../src/modules/admin/interfaces/admin-report-assignment.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import {
  ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_INDEX,
  ADMIN_REPORT_ASSIGNMENT_TTL_INDEX,
  AdminReportAssignmentRequest,
} from '../../src/modules/admin/schemas/admin-report-assignment-request.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminReportAssignmentService } from '../../src/modules/admin/services/admin-report-assignment.service';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import {
  RetentionCleanupStatus,
  SystemReport,
  SystemReportSource,
  SystemReportType,
} from '../../src/modules/reports/schemas/system-report.schema';
import { generateSystemReportPublicId } from '../../src/modules/reports/utils/generate-system-report-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_report_assign_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 6);

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `report-assignment-it-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 111).toString('base64'),
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

jest.setTimeout(120_000);

describe('Admin report assignment MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let adminAccounts: Model<AdminAccount>;
  let adminSessions: Model<AdminSession>;
  let reports: Model<Report>;
  let systemReports: Model<SystemReport>;
  let audits: Model<AdminAuditEvent>;
  let requests: Model<AdminReportAssignmentRequest>;
  let service: AdminReportAssignmentService;
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
    if (!databaseName.startsWith(DATABASE_PREFIX) || databaseName.length > 38) {
      throw new Error('Ten integration database khong an toan');
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
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
      .useValue(TEST_SECRETS)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    adminAccounts = moduleRef.get(getModelToken(AdminAccount.name));
    adminSessions = moduleRef.get(getModelToken(AdminSession.name));
    reports = moduleRef.get(getModelToken(Report.name));
    systemReports = moduleRef.get(getModelToken(SystemReport.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    requests = moduleRef.get(getModelToken(AdminReportAssignmentRequest.name));
    service = moduleRef.get(AdminReportAssignmentService);
    audit = moduleRef.get(AdminAuditService);

    await Promise.all([
      adminAccounts.syncIndexes(),
      adminSessions.syncIndexes(),
      reports.syncIndexes(),
      systemReports.syncIndexes(),
      audits.syncIndexes(),
      requests.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
      adminAccounts.deleteMany({}),
      adminSessions.deleteMany({}),
      reports.deleteMany({}),
      systemReports.deleteMany({}),
      audits.collection.deleteMany({}),
      requests.deleteMany({}),
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

  const createActor = async (
    role: AdminRole = AdminRole.ADMIN,
    label: string = randomUUID().replace(/-/gu, '').slice(0, 10),
  ): Promise<AdminReportAssignmentActor> => {
    const account = await adminAccounts.create({
      publicId: generateAdminPublicId(),
      email: `${label}.${randomUUID()}@betta.test`,
      username: `adm_${label}`.slice(0, 40),
      displayName: `Report Operator ${label}`,
      role,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: `atotp_v1.integration.${label}`,
      activationGrantConsumedAt: new Date(),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      version: 0,
      lockedAt: null,
      deletedAt: null,
    });
    const session = await adminSessions.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      refreshTokenHash:
        'sha256-v1:' + randomUUID().replace(/-/gu, '').padEnd(64, 'a'),
      deviceLabel: 'Integration',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      revokedAt: null,
      revokeReason: null,
    });

    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: account._id,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role,
      permission: AdminPermission.REPORTS_REVIEW,
      permissionVersion: 1,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
    });
  };

  const createReport = async () =>
    reports.create({
      reporterId: new Types.ObjectId(),
      targetType: ReportTargetType.USER,
      targetId: new Types.ObjectId(),
      reasonGroup: ReportReasonGroup.IMPERSONATION,
      reasonDetail: 'report assignment integration',
      description: 'claim race fixture',
      targetSnapshot: {
        publicId: `usr_${'2'.repeat(10)}`,
        username: 'target_user',
      },
    });

  const createSystemReport = async () =>
    systemReports.create({
      publicId: generateSystemReportPublicId(),
      source: SystemReportSource.AUTH_PUBLIC,
      reportType: SystemReportType.ACCOUNT_ACCESS,
      category: 'LOGIN_PROBLEM',
      description: 'system report assignment integration',
      descriptionHash: randomUUID().replace(/-/gu, ''),
      dedupeKey: `assignment:${randomUUID()}`,
    });

  const input = (
    actor: AdminReportAssignmentActor,
    reportPublicId: string,
    idempotencyKey: string,
    overrides: Partial<UpdateAdminReportAssignmentInput> = {},
  ): UpdateAdminReportAssignmentInput => ({
    actor,
    reportPublicId,
    operation: AdminReportAssignmentOperation.CLAIM,
    expectedVersion: 0,
    adminNote: 'Nhan xu ly report theo hang doi',
    correlationId: `assignment:${randomUUID()}`,
    idempotencyKey,
    ...overrides,
  });

  it('claims both report kinds, preserves SLA and replays exactly once', async () => {
    const actor = await createActor();
    const [report, systemReport] = await Promise.all([
      createReport(),
      createSystemReport(),
    ]);
    const reportDueAt = report.decisionDueAt?.getTime();
    const systemDueAt = systemReport.decisionDueAt?.getTime();
    const reportInput = input(
      actor,
      report.publicId as string,
      'claim-report-23456789',
    );
    const systemInput = input(
      actor,
      systemReport.publicId as string,
      'claim-system-report-23456789',
    );

    const [claimedReport, claimedSystem] = await Promise.all([
      service.update(reportInput),
      service.update(systemInput),
    ]);
    await expect(service.update(reportInput)).resolves.toEqual(claimedReport);

    expect(claimedReport.report).toEqual(
      expect.objectContaining({
        kind: AdminReportAssignmentKind.REPORT,
        status: AdminReportQueueStatus.REVIEWING,
        version: 1,
      }),
    );
    expect(claimedSystem.report).toEqual(
      expect.objectContaining({
        kind: AdminReportAssignmentKind.SYSTEM_REPORT,
        status: AdminReportQueueStatus.REVIEWING,
        version: 1,
      }),
    );

    const [storedReport, storedSystem, storedAudits, storedRequests] =
      await Promise.all([
        reports.findById(report._id).lean().exec(),
        systemReports.findById(systemReport._id).lean().exec(),
        audits.find({}).lean().exec(),
        requests.find({}).lean().exec(),
      ]);
    expect(storedReport?.decisionDueAt?.getTime()).toBe(reportDueAt);
    expect(storedSystem?.decisionDueAt?.getTime()).toBe(systemDueAt);
    expect(storedAudits).toHaveLength(2);
    expect(storedRequests).toHaveLength(2);
    const indexes = await requests.collection.listIndexes().toArray();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_INDEX,
          unique: true,
        }),
        expect.objectContaining({
          name: ADMIN_REPORT_ASSIGNMENT_TTL_INDEX,
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it('returns the authoritative winner for different-key claim races', async () => {
    const [firstActor, secondActor, report] = await Promise.all([
      createActor(AdminRole.ADMIN, 'racefirst'),
      createActor(AdminRole.ADMIN, 'racesecond'),
      createReport(),
    ]);
    const publicId = report.publicId as string;
    const outcomes = await Promise.allSettled([
      service.update(input(firstActor, publicId, 'claim-race-first-2345')),
      service.update(input(secondActor, publicId, 'claim-race-second-234')),
    ]);

    const winner = outcomes.find(({ status }) => status === 'fulfilled');
    const loser = outcomes.find(({ status }) => status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') {
      throw new Error('Concurrent claim did not produce one winner');
    }

    expect(loser.reason).toBeInstanceOf(AdminReportAssignmentConflictException);
    const conflictBody = (
      loser.reason as AdminReportAssignmentConflictException
    ).getResponse();
    expect(conflictBody).toEqual({
      error: REPORT_ASSIGNMENT_CONFLICT_ERROR,
      message: 'Report đã được cập nhật bởi yêu cầu khác',
      currentAssignment: {
        publicId,
        kind: winner.value.report.kind,
        status: winner.value.report.status,
        assignee: winner.value.report.assignee,
        version: winner.value.report.version,
      },
    });
    expect(JSON.stringify(conflictBody)).not.toMatch(
      /targetReportId|ObjectId|evidence|contact/iu,
    );

    const stored = await reports.findById(report._id).lean().exec();
    expect(stored?.version).toBe(1);
    expect(await audits.countDocuments({})).toBe(1);
    expect(await requests.countDocuments({})).toBe(1);
  });

  it('converges concurrent same-key requests and rejects another fingerprint', async () => {
    const actor = await createActor(AdminRole.ADMIN, 'samekey');
    const report = await createReport();
    const mutation = input(
      actor,
      report.publicId as string,
      'claim-same-key-concurrent-2345',
      { correlationId: 'assignment:same-key-concurrent-2345' },
    );

    const [first, second] = await Promise.all([
      service.update(mutation),
      service.update(mutation),
    ]);
    expect(second).toEqual(first);

    const differentFingerprint = {
      ...mutation,
      adminNote: 'Nhan xu ly report voi payload khac',
    };
    await expect(service.update(differentFingerprint)).rejects.toBeInstanceOf(
      AdminReportAssignmentIdempotencyConflictException,
    );
    try {
      await service.update(differentFingerprint);
      throw new Error('Expected idempotency conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(
        AdminReportAssignmentIdempotencyConflictException,
      );
      expect(
        (
          error as AdminReportAssignmentIdempotencyConflictException
        ).getResponse(),
      ).toEqual({
        error: REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT_ERROR,
        message: 'Idempotency-Key đã được dùng cho payload khác',
      });
    }

    const storedRequest = await requests.findOne({}).lean().exec();
    expect(storedRequest).toEqual(
      expect.objectContaining({
        state: AdminReportAssignmentRequestState.COMPLETED,
        resultVersion: 1,
      }),
    );
    expect(await reports.countDocuments({ version: 1 })).toBe(1);
    expect(await audits.countDocuments({})).toBe(1);
    expect(await requests.countDocuments({})).toBe(1);
  });
  it('restricts reassign to SuperAdmin and preserves the active lifecycle', async () => {
    const [owner, ordinaryAdmin, superAdmin, nextOwner, report] =
      await Promise.all([
        createActor(AdminRole.ADMIN, 'owner'),
        createActor(AdminRole.ADMIN, 'ordinary'),
        createActor(AdminRole.SUPER_ADMIN, 'superowner'),
        createActor(AdminRole.ADMIN, 'nextowner'),
        createReport(),
      ]);
    const publicId = report.publicId as string;
    await service.update(input(owner, publicId, 'claim-before-reassign-1'));

    const ordinaryReassign = input(
      ordinaryAdmin,
      publicId,
      'ordinary-reassign-2345',
      {
        operation: AdminReportAssignmentOperation.REASSIGN,
        expectedVersion: 1,
        assigneePublicId: nextOwner.publicId,
        adminNote: 'Chuyen nguoi xu ly do dieu phoi',
      },
    );
    await expect(service.update(ordinaryReassign)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const reassign = input(superAdmin, publicId, 'super-reassign-234567', {
      operation: AdminReportAssignmentOperation.REASSIGN,
      expectedVersion: 1,
      assigneePublicId: nextOwner.publicId,
      adminNote: 'Chuyen nguoi xu ly do dieu phoi',
    });
    const result = await service.update(reassign);
    await expect(service.update(reassign)).resolves.toEqual(result);
    expect(result.report).toEqual(
      expect.objectContaining({
        status: AdminReportQueueStatus.REVIEWING,
        version: 2,
      }),
    );
    expect(result.report.assignee.publicId).toBe(nextOwner.publicId);

    const reassignAudit = await audits
      .findOne({ action: AdminAuditAction.REPORT_REASSIGNED })
      .lean()
      .exec();
    expect(reassignAudit?.metadata).toEqual(
      expect.objectContaining({
        beforeAssigneePublicId: owner.publicId,
        afterAssigneePublicId: nextOwner.publicId,
      }),
    );

    await expect(
      service.update({
        ...reassign,
        assigneePublicId: ordinaryAdmin.publicId,
      }),
    ).rejects.toThrow('Idempotency-Key đã được dùng cho payload khác');
    const staleReassign = {
      ...input(superAdmin, publicId, 'stale-reassign-2345678'),
      operation: AdminReportAssignmentOperation.REASSIGN,
      expectedVersion: 1,
      assigneePublicId: ordinaryAdmin.publicId,
      adminNote: 'Thu nghiem stale version hop le',
    };
    try {
      await service.update(staleReassign);
      throw new Error('Expected stale assignment conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AdminReportAssignmentConflictException);
      expect(
        (error as AdminReportAssignmentConflictException).getResponse(),
      ).toEqual({
        error: REPORT_ASSIGNMENT_CONFLICT_ERROR,
        message: 'Report đã được cập nhật bởi yêu cầu khác',
        currentAssignment: {
          publicId,
          kind: result.report.kind,
          status: result.report.status,
          assignee: result.report.assignee,
          version: result.report.version,
        },
      });
    }
  });

  it('rolls back assignment, audit and request when audit persistence fails', async () => {
    const actor = await createActor();
    const report = await createReport();
    const mutation = input(
      actor,
      report.publicId as string,
      'claim-audit-rollback-2345',
    );
    const auditSpy = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('forced audit failure'));

    await expect(service.update(mutation)).rejects.toThrow(
      'forced audit failure',
    );
    const rolledBack = await reports.findById(report._id).lean().exec();
    expect(rolledBack).toEqual(
      expect.objectContaining({
        status: ReportStatus.PENDING,
        version: 0,
        assigneePublicId: null,
      }),
    );
    expect(await audits.countDocuments({})).toBe(0);
    expect(await requests.countDocuments({})).toBe(0);

    auditSpy.mockRestore();
    await expect(service.update(mutation)).resolves.toEqual(
      expect.objectContaining({
        report: expect.objectContaining({ version: 1 }),
      }),
    );
  });

  it('rejects system reports after retention processing starts', async () => {
    const actor = await createActor();
    const systemReport = await createSystemReport();
    await systemReports.updateOne(
      { _id: systemReport._id },
      { $set: { retentionCleanupStatus: RetentionCleanupStatus.PROCESSING } },
    );

    await expect(
      service.update(
        input(
          actor,
          systemReport.publicId as string,
          'claim-retention-locked-1',
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await requests.countDocuments({})).toBe(0);
  });
});
