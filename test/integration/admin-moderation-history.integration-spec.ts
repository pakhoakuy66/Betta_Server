import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createConnection, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import {
  ADMIN_AUDIT_RETENTION_INDEX,
  ADMIN_AUDIT_TARGET_INDEX,
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../../src/modules/admin/schemas/admin-audit-event.schema';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import {
  AdminModerationHistoryResource,
  AdminModerationHistoryTargetAvailability,
  AdminModerationHistoryTargetType,
} from '../../src/modules/admin/constants/admin-moderation-history.constants';
import { AdminModerationHistoryController } from '../../src/modules/admin/controllers/admin-moderation-history.controller';
import { AdminJwtAuthGuard } from '../../src/modules/admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../../src/modules/admin/guards/admin-permission.guard';
import { AdminModerationHistoryService } from '../../src/modules/admin/services/admin-moderation-history.service';
import { Post, PostSchema } from '../../src/modules/posts/schemas/post.schema';
import {
  Report,
  ReportSchema,
} from '../../src/modules/reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportSchema,
} from '../../src/modules/reports/schemas/system-report.schema';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_mod09_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);
const USER_PUBLIC_ID = 'usr_23456789AB';
const POST_PUBLIC_ID = 'post_23456789ABCD';
const REPORT_PUBLIC_ID = 'rpt_23456789ABCDEFGH';
const SYSTEM_REPORT_PUBLIC_ID = 'srep_23456789ABCDEFGH';
const ADMIN_PRINCIPAL = Object.freeze({
  adminAccountId: '64b000000000000000000001',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'moderator',
  displayName: 'Moderator',
  role: AdminRole.ADMIN,
  sessionId: 'ases_23456789ABCDEFGH',
  credentialVersion: 1,
  authzVersion: 1,
  permissionVersion: 1,
});

const AUDIT_IDS = Object.freeze([
  'aaud_23456789ABCDEFGH',
  'aaud_23456789ABCDEFGJ',
  'aaud_23456789ABCDEFGK',
  'aaud_23456789ABCDEFGM',
  'aaud_23456789ABCDEFGN',
  'aaud_23456789ABCDEFGP',
]);

class TestAuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown>; user?: unknown }>();
    if (httpRequest.headers['x-test-principal'] === 'admin') {
      httpRequest.user = ADMIN_PRINCIPAL;
    } else if (httpRequest.headers['x-test-principal'] === 'user') {
      httpRequest.user = { id: USER_PUBLIC_ID };
    }
    return true;
  }
}

jest.setTimeout(120_000);

describe('ADM-MOD-09 moderation history MongoDB integration', () => {
  let connection: Connection;
  let auditEvents: Model<AdminAuditEvent>;
  let users: Model<User>;
  let posts: Model<Post>;
  let reports: Model<Report>;
  let systemReports: Model<SystemReport>;
  let service: AdminModerationHistoryService;
  let app: INestApplication;
  let httpServer: Server;

  const insertAudit = async (input: {
    publicId: string;
    action: AdminAuditAction;
    targetType: AdminAuditTargetType;
    targetPublicId: string;
    occurredAt: Date;
    expiresAt?: Date;
    extra?: Record<string, unknown>;
  }): Promise<void> => {
    await auditEvents.collection.insertOne({
      publicId: input.publicId,
      schemaVersion: 1,
      action: input.action,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        publicId: ADMIN_PRINCIPAL.publicId,
        username: ADMIN_PRINCIPAL.username,
        displayName: ADMIN_PRINCIPAL.displayName,
        role: ADMIN_PRINCIPAL.role,
        permission: 'moderation_history.view',
        permissionVersion: 1,
      },
      target: {
        type: input.targetType,
        publicId: input.targetPublicId,
        displayName: 'Private target snapshot',
      },
      reasonCode: 'moderation_policy',
      reasonNote: 'Internal moderation note',
      metadata: {
        beforeVersion: 1,
        afterVersion: 2,
        beforeState: 'ACTIVE',
        afterState: 'HIDDEN',
        beforeAssigneePublicId: 'adm_23456789ABCE',
      },
      correlationId: 'corr_2026083000000001',
      source: AdminAuditSource.HTTP,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 365 * 86_400_000),
      occurredAt: input.occurredAt,
      ...(input.extra ?? {}),
    });
  };

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} is not configured`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES is required`);
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI must not match the runtime URI');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();
    auditEvents = connection.model(
      AdminAuditEvent.name,
      AdminAuditEventSchema.clone(),
    );
    users = connection.model(User.name, UserSchema.clone());
    posts = connection.model(Post.name, PostSchema.clone());
    reports = connection.model(Report.name, ReportSchema.clone());
    systemReports = connection.model(
      SystemReport.name,
      SystemReportSchema.clone(),
    );
    await auditEvents.syncIndexes();
    service = new AdminModerationHistoryService(
      auditEvents,
      users,
      posts,
      reports,
      systemReports,
    );

    const testingModule = await Test.createTestingModule({
      controllers: [AdminModerationHistoryController],
      providers: [
        { provide: AdminModerationHistoryService, useValue: service },
        AdminPermissionGuard,
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useClass(TestAuthenticationGuard)
      .compile();
    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await Promise.all([
      auditEvents.collection.deleteMany({}),
      users.collection.deleteMany({}),
      posts.collection.deleteMany({}),
      reports.collection.deleteMany({}),
      systemReports.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Refusing to drop database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('uses deterministic Package A page pagination with a publicId tie-breaker', async () => {
    await users.collection.insertOne({
      publicId: USER_PUBLIC_ID,
      isDeleted: false,
    });
    const times = [
      new Date('2026-08-30T03:00:00.000Z'),
      new Date('2026-08-30T03:00:00.000Z'),
      new Date('2026-08-30T01:00:00.000Z'),
    ];
    for (const [index, occurredAt] of times.entries()) {
      await insertAudit({
        publicId: AUDIT_IDS[index],
        action: AdminAuditAction.USER_SUSPENDED,
        targetType: AdminAuditTargetType.USER,
        targetPublicId: USER_PUBLIC_ID,
        occurredAt,
      });
    }

    const first = await service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: USER_PUBLIC_ID,
      page: 1,
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual(AUDIT_IDS.slice(0, 2));
    expect(first.pagination).toEqual({
      page: 1,
      limit: 2,
      hasMore: true,
    });

    const second = await service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: USER_PUBLIC_ID,
      page: 2,
      limit: 2,
    });
    expect(second.items.map((item) => item.id)).toEqual([AUDIT_IDS[2]]);
    expect(second.pagination).toEqual({
      page: 2,
      limit: 2,
      hasMore: false,
    });

    const repeatedFirst = await service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: USER_PUBLIC_ID,
      page: 1,
      limit: 2,
    });
    expect(repeatedFirst.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
  });

  it('returns a deleted target from retained history with no internal field leak', async () => {
    await insertAudit({
      publicId: AUDIT_IDS[0],
      action: AdminAuditAction.POST_DELETED,
      targetType: AdminAuditTargetType.POST,
      targetPublicId: POST_PUBLIC_ID,
      occurredAt: new Date('2026-08-30T01:00:00.000Z'),
      extra: {
        reporterId: '64b000000000000000000099',
        adminNote: 'must-not-leak',
        rawContact: 'must-not-leak@example.com',
        token: 'must-not-leak-token',
        evidence: {
          publicId: 'cloudinary-private-id',
          url: 'https://res.cloudinary.com/private/image.jpg',
        },
      },
    });

    const result = await service.list({
      resource: AdminModerationHistoryResource.POST,
      targetPublicId: POST_PUBLIC_ID,
      page: 1,
      limit: 20,
    });
    expect(result.target).toEqual({
      type: AdminModerationHistoryTargetType.POST,
      publicId: POST_PUBLIC_ID,
      availability: AdminModerationHistoryTargetAvailability.DELETED,
    });
    expect(result.items[0]?.actor).toEqual({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: ADMIN_PRINCIPAL.publicId,
      role: AdminRole.ADMIN,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /64b0000000000000000000|username|displayName|permission|reasonNote|adminNote|rawContact|token|cloudinary|evidence|beforeAssignee/iu,
    );
  });

  it('maps Report and SystemReport independently and filters unrelated actions', async () => {
    await reports.collection.insertOne({ publicId: REPORT_PUBLIC_ID });
    await systemReports.collection.insertOne({
      publicId: SYSTEM_REPORT_PUBLIC_ID,
    });
    await insertAudit({
      publicId: AUDIT_IDS[0],
      action: AdminAuditAction.REPORT_RESOLVED,
      targetType: AdminAuditTargetType.REPORT,
      targetPublicId: REPORT_PUBLIC_ID,
      occurredAt: new Date('2026-08-30T01:00:00.000Z'),
    });
    await insertAudit({
      publicId: AUDIT_IDS[1],
      action: AdminAuditAction.SYSTEM_REPORT_TRANSITIONED,
      targetType: AdminAuditTargetType.SYSTEM_REPORT,
      targetPublicId: SYSTEM_REPORT_PUBLIC_ID,
      occurredAt: new Date('2026-08-30T02:00:00.000Z'),
    });

    const reportPage = await service.list({
      resource: AdminModerationHistoryResource.REPORT,
      targetPublicId: REPORT_PUBLIC_ID,
      page: 1,
      limit: 20,
    });
    const systemPage = await service.list({
      resource: AdminModerationHistoryResource.REPORT,
      targetPublicId: SYSTEM_REPORT_PUBLIC_ID,
      page: 1,
      limit: 20,
    });

    expect(reportPage.target.type).toBe(
      AdminModerationHistoryTargetType.REPORT,
    );
    expect(reportPage.items.map((item) => item.action)).toEqual([
      AdminAuditAction.REPORT_RESOLVED,
    ]);
    expect(systemPage.target.type).toBe(
      AdminModerationHistoryTargetType.SYSTEM_REPORT,
    );
    expect(systemPage.items.map((item) => item.action)).toEqual([
      AdminAuditAction.SYSTEM_REPORT_TRANSITIONED,
    ]);
  });

  it('excludes logically expired history before asynchronous TTL deletion', async () => {
    await users.collection.insertOne({
      publicId: USER_PUBLIC_ID,
      isDeleted: false,
    });
    await insertAudit({
      publicId: AUDIT_IDS[0],
      action: AdminAuditAction.USER_SUSPENDED,
      targetType: AdminAuditTargetType.USER,
      targetPublicId: USER_PUBLIC_ID,
      occurredAt: new Date('2025-08-29T01:00:00.000Z'),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const result = await service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: USER_PUBLIC_ID,
      page: 1,
      limit: 20,
    });
    expect(result.items).toEqual([]);
    expect(await auditEvents.countDocuments({})).toBe(1);
  });

  it('returns 404 only when both the target and retained history are absent', async () => {
    await expect(
      service.list({
        resource: AdminModerationHistoryResource.POST,
        targetPublicId: POST_PUBLIC_ID,
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the application model append-only for update, replace, delete and bulkWrite', async () => {
    await insertAudit({
      publicId: AUDIT_IDS[0],
      action: AdminAuditAction.USER_SUSPENDED,
      targetType: AdminAuditTargetType.USER,
      targetPublicId: USER_PUBLIC_ID,
      occurredAt: new Date('2026-08-30T01:00:00.000Z'),
    });

    await expect(
      auditEvents
        .updateOne(
          { publicId: AUDIT_IDS[0] },
          { $set: { reasonCode: 'changed' } },
        )
        .exec(),
    ).rejects.toThrow('append-only');
    await expect(
      auditEvents
        .replaceOne({ publicId: AUDIT_IDS[0] }, {
          publicId: AUDIT_IDS[0],
          reasonCode: 'changed',
        } as never)
        .exec(),
    ).rejects.toThrow('append-only');
    await expect(
      auditEvents.deleteOne({ publicId: AUDIT_IDS[0] }).exec(),
    ).rejects.toThrow('append-only');
    await expect(
      auditEvents.bulkWrite([
        {
          updateOne: {
            filter: { publicId: AUDIT_IDS[0] },
            update: { $set: { reasonCode: 'changed' } },
          },
        },
      ]),
    ).rejects.toThrow('append-only');
    expect(await auditEvents.countDocuments({})).toBe(1);
  });

  it('keeps 365-day TTL and target keyset query indexes', async () => {
    type ListedIndex = Readonly<{
      name: string;
      expireAfterSeconds?: number;
      key: Record<string, number>;
    }>;
    const indexes = (await auditEvents.collection
      .listIndexes()
      .toArray()) as unknown as ListedIndex[];
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get(ADMIN_AUDIT_RETENTION_INDEX)?.expireAfterSeconds).toBe(0);
    expect(byName.get(ADMIN_AUDIT_TARGET_INDEX)?.key).toEqual({
      'target.type': 1,
      'target.publicId': 1,
      occurredAt: -1,
      publicId: 1,
    });
  });

  it('enforces Admin authentication and both permissions on the HTTP route', async () => {
    await users.collection.insertOne({
      publicId: USER_PUBLIC_ID,
      isDeleted: false,
    });

    await request(httpServer)
      .get(`/api/v1/admin/users/${USER_PUBLIC_ID}/moderation-history`)
      .expect(401);
    await request(httpServer)
      .get(`/api/v1/admin/users/${USER_PUBLIC_ID}/moderation-history`)
      .set('x-test-principal', 'user')
      .expect(401);
    await request(httpServer)
      .get('/api/v1/admin/users/' + USER_PUBLIC_ID + '/moderation-history')
      .query({ cursor: 'legacy-cursor-is-not-package-a' })
      .set('x-test-principal', 'admin')
      .expect(400);
    const response = await request(httpServer)
      .get(`/api/v1/admin/users/${USER_PUBLIC_ID}/moderation-history`)
      .set('x-test-principal', 'admin')
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const responseBody = response.body as unknown;
    expect(responseBody).toMatchObject({
      target: { publicId: USER_PUBLIC_ID },
      pagination: { page: 1, limit: 20, hasMore: false },
    });
  });
});
