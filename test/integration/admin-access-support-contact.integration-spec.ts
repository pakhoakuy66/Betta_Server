import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
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
import { createConnection, type Connection, type Model, Types } from 'mongoose';
import request from 'supertest';
import { createAdminPolicy } from '../../src/modules/admin/config/admin-policy.config';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { AdminReauthPurpose } from '../../src/modules/admin/constants/admin-reauth.constants';
import { AdminAccessSupportContactController } from '../../src/modules/admin/controllers/admin-access-support-contact.controller';
import { AdminJwtAuthGuard } from '../../src/modules/admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../../src/modules/admin/guards/admin-permission.guard';
import { type AdminAccessSupportContactActor } from '../../src/modules/admin/interfaces/admin-access-support-contact.interface';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../../src/modules/admin/schemas/admin-audit-event.schema';
import {
  AdminReauthGrant,
  AdminReauthGrantSchema,
} from '../../src/modules/admin/schemas/admin-reauth-grant.schema';
import {
  AdminSession,
  AdminSessionSchema,
} from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminAccessSupportContactService } from '../../src/modules/admin/services/admin-access-support-contact.service';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminReauthService } from '../../src/modules/admin/services/admin-reauth.service';
import {
  generateAdminSecurityGrant,
  hashAdminReauthGrant,
} from '../../src/modules/admin/utils/admin-security-grant';
import { generateAdminSessionFamily } from '../../src/modules/admin/utils/generate-admin-session-id';
import { AccessSupportSecretsConfig } from '../../src/modules/reports/config/access-support-secrets.config';
import { migrateAccessSupportContactMasks } from '../../src/modules/reports/migrations/access-support-contact-mask.migration';
import {
  SystemReport,
  SystemReportSchema,
  SystemReportSource,
  SystemReportStatus,
  SystemReportType,
} from '../../src/modules/reports/schemas/system-report.schema';
import { AccessSupportCryptoService } from '../../src/modules/reports/services/access-support-crypto.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_adm_mod10_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);
const REPORT_PUBLIC_ID = 'srep_23456789ABCDEFGH';
const OTHER_REPORT_PUBLIC_ID = 'srep_HGFEDCBA98765432';
const RAW_CONTACT = 'private.person@example.com';
const MASKED_CONTACT = 'p***@e***.com';
const ADMIN_ACCOUNT_ID = new Types.ObjectId('64b000000000000000000001');
const ADMIN_PUBLIC_ID = 'adm_23456789ABCD';
const SESSION_PUBLIC_ID = 'ases_23456789ABCDEFGH';
const CORRELATION_ID = 'corr_mod10_reveal_20260830_0001';

const SUPER_ADMIN_PRINCIPAL = Object.freeze({
  adminAccountId: ADMIN_ACCOUNT_ID.toHexString(),
  id: ADMIN_PUBLIC_ID,
  publicId: ADMIN_PUBLIC_ID,
  username: 'root_admin',
  displayName: 'Root Admin',
  role: AdminRole.SUPER_ADMIN,
  sessionId: SESSION_PUBLIC_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
});

const SUPER_ADMIN_ACTOR: AdminAccessSupportContactActor = Object.freeze({
  type: AdminAuditActorType.ADMIN_ACCOUNT,
  adminAccountId: ADMIN_ACCOUNT_ID,
  publicId: ADMIN_PUBLIC_ID,
  username: SUPER_ADMIN_PRINCIPAL.username,
  displayName: SUPER_ADMIN_PRINCIPAL.displayName,
  role: AdminRole.SUPER_ADMIN,
  permission: AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
  permissionVersion: SUPER_ADMIN_PRINCIPAL.permissionVersion,
  sessionPublicId: SESSION_PUBLIC_ID,
  credentialVersion: SUPER_ADMIN_PRINCIPAL.credentialVersion,
  authzVersion: SUPER_ADMIN_PRINCIPAL.authzVersion,
});

const TEST_ACCESS_SUPPORT_SECRETS = Object.freeze({
  encryption: Object.freeze({
    current: Object.freeze({ id: 'enc-mod10-it', key: Buffer.alloc(32, 17) }),
    all: Object.freeze([
      Object.freeze({ id: 'enc-mod10-it', key: Buffer.alloc(32, 17) }),
    ]),
  }),
  hmac: Object.freeze({
    current: Object.freeze({ id: 'hmac-mod10-it', key: Buffer.alloc(32, 29) }),
    all: Object.freeze([
      Object.freeze({ id: 'hmac-mod10-it', key: Buffer.alloc(32, 29) }),
    ]),
  }),
}) as unknown as AccessSupportSecretsConfig;

class TestAuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown>; user?: unknown }>();
    const principal = httpRequest.headers['x-test-principal'];
    if (principal === 'super-admin') {
      httpRequest.user = SUPER_ADMIN_PRINCIPAL;
    } else if (principal === 'admin') {
      httpRequest.user = {
        ...SUPER_ADMIN_PRINCIPAL,
        role: AdminRole.ADMIN,
      };
    } else if (principal === 'user') {
      httpRequest.user = { id: 'usr_23456789AB' };
    }
    return true;
  }
}

jest.setTimeout(120_000);

describe('ADM-MOD-10 access-support contact reveal MongoDB integration', () => {
  let connection: Connection;
  let systemReports: Model<SystemReport>;
  let sessions: Model<AdminSession>;
  let grants: Model<AdminReauthGrant>;
  let auditEvents: Model<AdminAuditEvent>;
  let crypto: AccessSupportCryptoService;
  let contacts: AdminAccessSupportContactService;
  let app: INestApplication;
  let httpServer: Server;

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
    systemReports = connection.model(
      SystemReport.name,
      SystemReportSchema.clone(),
    );
    sessions = connection.model(AdminSession.name, AdminSessionSchema.clone());
    grants = connection.model(
      AdminReauthGrant.name,
      AdminReauthGrantSchema.clone(),
    );
    auditEvents = connection.model(
      AdminAuditEvent.name,
      AdminAuditEventSchema.clone(),
    );
    await Promise.all([
      systemReports.syncIndexes(),
      sessions.syncIndexes(),
      grants.syncIndexes(),
      auditEvents.syncIndexes(),
    ]);

    const policy = createAdminPolicy({ get: () => undefined });
    const audit = new AdminAuditService(auditEvents, policy);
    const reauth = new AdminReauthService(
      {} as never,
      sessions,
      grants,
      connection,
      policy,
      {} as never,
      audit,
      {} as never,
    );
    crypto = new AccessSupportCryptoService(TEST_ACCESS_SUPPORT_SECRETS);
    contacts = new AdminAccessSupportContactService(
      systemReports,
      connection,
      crypto,
      reauth,
      audit,
    );

    const testingModule = await Test.createTestingModule({
      controllers: [AdminAccessSupportContactController],
      providers: [
        { provide: AdminAccessSupportContactService, useValue: contacts },
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
      systemReports.collection.deleteMany({}),
      sessions.collection.deleteMany({}),
      grants.collection.deleteMany({}),
      auditEvents.collection.deleteMany({}),
    ]);
    await sessions.create({
      adminAccountId: ADMIN_ACCOUNT_ID,
      adminPublicId: ADMIN_PUBLIC_ID,
      publicId: SESSION_PUBLIC_ID,
      tokenFamily: generateAdminSessionFamily(),
      tokenVersion: 0,
      refreshTokenHash: `sha256-v1:${'a'.repeat(64)}`,
      deviceLabel: 'ADM-MOD-10 integration browser',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      revokeReason: null,
    });
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

  const createReport = async (
    publicId = REPORT_PUBLIC_ID,
  ): Promise<Readonly<{ encryptedContact: string }>> => {
    const encryptedContact = crypto.encrypt(
      RAW_CONTACT,
      publicId,
      'contactEmail',
    );
    await systemReports.create({
      publicId,
      reporterId: null,
      source: SystemReportSource.AUTH_PUBLIC,
      reportType: SystemReportType.ACCOUNT_ACCESS,
      category: 'LOGIN_PROBLEM',
      encryptedContactEmail: encryptedContact,
      contactEmailMasked: MASKED_CONTACT,
      contactLookupHmac: 'hmac-mod10-it.contact-lookup',
      encryptedAccountIdentifier: 'asenc.v1.private-account-identifier',
      requestFingerprintHmac: 'hmac-mod10-it.request-fingerprint',
      correlationId: 'corr_mod10_intake_20260830_0001',
      description: 'Cannot access account',
      descriptionHash: 'd'.repeat(64),
      dedupeKey: `dedupe-${publicId}`,
      evidenceImages: [],
      status: SystemReportStatus.PENDING,
      evidencePurgedAt: null,
    });
    return Object.freeze({ encryptedContact });
  };

  const seedGrant = async (
    input: {
      purpose?: AdminReauthPurpose;
      targetPublicId?: string;
      expiresAt?: Date;
    } = {},
  ): Promise<string> => {
    const rawGrant = generateAdminSecurityGrant();
    const purpose = input.purpose ?? AdminReauthPurpose.REPORT_CONTACT_REVEAL;
    const targetPublicId = input.targetPublicId ?? REPORT_PUBLIC_ID;
    await grants.create({
      adminAccountId: ADMIN_ACCOUNT_ID,
      adminPublicId: ADMIN_PUBLIC_ID,
      sessionPublicId: SESSION_PUBLIC_ID,
      purpose,
      targetPublicId,
      grantHash: hashAdminReauthGrant({
        rawGrant,
        purpose,
        adminPublicId: ADMIN_PUBLIC_ID,
        sessionPublicId: SESSION_PUBLIC_ID,
        targetPublicId,
      }),
      credentialVersion: SUPER_ADMIN_PRINCIPAL.credentialVersion,
      authzVersion: SUPER_ADMIN_PRINCIPAL.authzVersion,
      permissionVersion: SUPER_ADMIN_PRINCIPAL.permissionVersion,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 300_000),
      consumedAt: null,
    });
    return rawGrant;
  };

  const reveal = (reauthGrant: string) =>
    contacts.reveal({
      actor: SUPER_ADMIN_ACTOR,
      reportPublicId: REPORT_PUBLIC_ID,
      reauthGrant,
      reason: 'support_follow_up',
      correlationId: CORRELATION_ID,
      source: AdminAuditSource.HTTP,
    });

  it('reveals once and stores only masked contact plus allowlisted audit metadata', async () => {
    const { encryptedContact } = await createReport();
    const rawGrant = await seedGrant();

    await expect(reveal(rawGrant)).resolves.toEqual({
      reportPublicId: REPORT_PUBLIC_ID,
      contactEmail: RAW_CONTACT,
    });

    const defaultReport = (await systemReports
      .findOne({ publicId: REPORT_PUBLIC_ID })
      .lean()
      .exec()) as unknown as Record<string, unknown>;
    expect(defaultReport.contactEmailMasked).toBe(MASKED_CONTACT);
    expect(defaultReport).not.toHaveProperty('encryptedContactEmail');
    expect(defaultReport).not.toHaveProperty('contactLookupHmac');

    const revealAudit = await auditEvents
      .findOne({ action: AdminAuditAction.CONTACT_REVEALED })
      .lean()
      .exec();
    expect(revealAudit).toMatchObject({
      outcome: AdminAuditOutcome.SUCCEEDED,
      target: {
        type: AdminAuditTargetType.SYSTEM_REPORT,
        publicId: REPORT_PUBLIC_ID,
      },
      reasonCode: 'support_follow_up',
      correlationId: CORRELATION_ID,
    });
    const serializedAudit = JSON.stringify(revealAudit);
    expect(serializedAudit).not.toContain(RAW_CONTACT);
    expect(serializedAudit).not.toContain(encryptedContact);
    expect(serializedAudit).not.toContain('contact-lookup');
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(1);
    await expect(reveal(rawGrant)).rejects.toMatchObject({ status: 401 });
  });

  it('backfills legacy masks without removing ciphertext and isolates corrupt records', async () => {
    const { encryptedContact } = await createReport();
    await systemReports.collection.updateOne(
      { publicId: REPORT_PUBLIC_ID },
      { $unset: { contactEmailMasked: '' } },
    );
    await systemReports.collection.insertOne({
      publicId: OTHER_REPORT_PUBLIC_ID,
      source: SystemReportSource.AUTH_PUBLIC,
      reportType: SystemReportType.ACCOUNT_ACCESS,
      encryptedContactEmail: 'corrupt-envelope',
      evidencePurgedAt: null,
      description: 'Legacy corrupt record',
      descriptionHash: 'e'.repeat(64),
      dedupeKey: 'dedupe-corrupt-contact-mask',
      status: SystemReportStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await migrateAccessSupportContactMasks(
      { systemReports: systemReports.collection as never },
      crypto,
      { execute: true, batchSize: 100 },
    );

    expect(result).toMatchObject({
      scanned: 2,
      planned: 1,
      updated: 1,
      failed: 1,
      hasMore: false,
    });
    const migrated = await systemReports
      .findOne({ publicId: REPORT_PUBLIC_ID })
      .select('+encryptedContactEmail')
      .lean()
      .exec();
    expect(migrated).toMatchObject({
      contactEmailMasked: MASKED_CONTACT,
      encryptedContactEmail: encryptedContact,
    });
    const corrupt = await systemReports.collection.findOne({
      publicId: OTHER_REPORT_PUBLIC_ID,
    });
    expect(corrupt).not.toHaveProperty('contactEmailMasked');
  });

  it('rejects wrong-target, wrong-purpose and expired grants before decrypt', async () => {
    await createReport();
    const decrypt = jest.spyOn(crypto, 'decrypt');
    const wrongTarget = await seedGrant({
      targetPublicId: OTHER_REPORT_PUBLIC_ID,
    });
    const wrongPurpose = await seedGrant({
      purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
    });
    const expired = await seedGrant({
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(reveal(wrongTarget)).rejects.toMatchObject({ status: 401 });
    await expect(reveal(wrongPurpose)).rejects.toMatchObject({ status: 401 });
    await expect(reveal(expired)).rejects.toMatchObject({ status: 401 });

    expect(decrypt).not.toHaveBeenCalled();
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(0);
    expect(
      await auditEvents.countDocuments({
        action: AdminAuditAction.CONTACT_REVEALED,
        outcome: AdminAuditOutcome.DENIED,
      }),
    ).toBe(3);
    decrypt.mockRestore();
  });

  it('allows exactly one concurrent reveal for a single-use grant', async () => {
    await createReport();
    const rawGrant = await seedGrant();
    const decrypt = jest.spyOn(crypto, 'decrypt');

    const outcomes = await Promise.allSettled([
      reveal(rawGrant),
      reveal(rawGrant),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(
      await auditEvents.countDocuments({
        action: AdminAuditAction.CONTACT_REVEALED,
        outcome: AdminAuditOutcome.SUCCEEDED,
      }),
    ).toBe(1);
    expect(
      await auditEvents.countDocuments({
        action: AdminAuditAction.REAUTH_GRANT_CONSUMED,
      }),
    ).toBe(1);
    decrypt.mockRestore();
  });

  it('denies a non-SuperAdmin and fails closed after contact purge', async () => {
    await createReport();
    const rawGrant = await seedGrant();
    const adminActor = {
      ...SUPER_ADMIN_ACTOR,
      role: AdminRole.ADMIN,
    } as AdminAccessSupportContactActor;

    await expect(
      contacts.reveal({
        actor: adminActor,
        reportPublicId: REPORT_PUBLIC_ID,
        reauthGrant: rawGrant,
        reason: 'support_follow_up',
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await systemReports.collection.updateOne(
      { publicId: REPORT_PUBLIC_ID },
      {
        $unset: {
          encryptedContactEmail: '',
          contactEmailMasked: '',
          contactLookupHmac: '',
        },
        $set: { evidencePurgedAt: new Date() },
      },
    );
    await expect(reveal(rawGrant)).rejects.toMatchObject({ status: 404 });
    expect(await grants.countDocuments({ consumedAt: { $ne: null } })).toBe(0);
  });

  it('enforces authentication, SuperAdmin permission, validation and private headers', async () => {
    await createReport();
    const rawGrant = await seedGrant();
    const path = `/api/v1/admin/reports/${REPORT_PUBLIC_ID}/contact/reveal`;
    const body = {
      reauthGrant: rawGrant,
      reason: 'support_follow_up',
      correlationId: CORRELATION_ID,
    };

    await request(httpServer).post(path).send(body).expect(401);
    await request(httpServer)
      .post(path)
      .set('x-test-principal', 'user')
      .send(body)
      .expect(401);
    await request(httpServer)
      .post(path)
      .set('x-test-principal', 'admin')
      .send(body)
      .expect(403);
    await request(httpServer)
      .post(path)
      .set('x-test-principal', 'super-admin')
      .send({ ...body, reason: RAW_CONTACT })
      .expect(400);

    const response = await request(httpServer)
      .post(path)
      .set('x-test-principal', 'super-admin')
      .send(body)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual({
      reportPublicId: REPORT_PUBLIC_ID,
      contactEmail: RAW_CONTACT,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /ObjectId|encrypted|Hmac|adminAccountId|sessionPublicId/iu,
    );
  });
});
