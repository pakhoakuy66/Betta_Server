import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { type Connection, type Model } from 'mongoose';
import { OutboxEvent } from '../../src/common/outbox/outbox-event.schema';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
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
import { AdminUserRestrictionOperation } from '../../src/modules/admin/constants/admin-user-restriction.constants';
import type {
  AdminUserRestrictionActor,
  UpdateAdminUserRestrictionInput,
} from '../../src/modules/admin/interfaces/admin-user-restriction.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminUserRestrictionRequest } from '../../src/modules/admin/schemas/admin-user-restriction-request.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminUserRestrictionService } from '../../src/modules/admin/services/admin-user-restriction.service';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import { User } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_usr_restrict_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 6);

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `user-restriction-it-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 51).toString('base64'),
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

describe('Admin User restriction MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let adminAccounts: Model<AdminAccount>;
  let adminSessions: Model<AdminSession>;
  let users: Model<User>;
  let authSessions: Model<AuthSession>;
  let audits: Model<AdminAuditEvent>;
  let outbox: Model<OutboxEvent>;
  let requests: Model<AdminUserRestrictionRequest>;
  let service: AdminUserRestrictionService;
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
      .useValue(TEST_SECRETS)
      .compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    adminAccounts = moduleRef.get(getModelToken(AdminAccount.name));
    adminSessions = moduleRef.get(getModelToken(AdminSession.name));
    users = moduleRef.get(getModelToken(User.name));
    authSessions = moduleRef.get(getModelToken(AuthSession.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outbox = moduleRef.get(getModelToken(OutboxEvent.name));
    requests = moduleRef.get(getModelToken(AdminUserRestrictionRequest.name));
    service = moduleRef.get(AdminUserRestrictionService);
    audit = moduleRef.get(AdminAuditService);

    await Promise.all([
      adminAccounts.syncIndexes(),
      adminSessions.syncIndexes(),
      users.syncIndexes(),
      authSessions.syncIndexes(),
      audits.syncIndexes(),
      outbox.syncIndexes(),
      requests.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
      adminAccounts.deleteMany({}),
      adminSessions.deleteMany({}),
      users.deleteMany({}),
      authSessions.deleteMany({}),
      audits.collection.deleteMany({}),
      outbox.deleteMany({}),
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
    permission: AdminPermission = AdminPermission.USERS_SUSPEND,
  ): Promise<AdminUserRestrictionActor> => {
    const role =
      permission === AdminPermission.USERS_BAN ||
      permission === AdminPermission.USERS_UNBAN
        ? AdminRole.SUPER_ADMIN
        : AdminRole.ADMIN;
    const account = await adminAccounts.create({
      publicId: generateAdminPublicId(),
      email: `${randomUUID()}@betta.test`,
      username: `adm_${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
      displayName: 'Moderation Operator',
      role,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'atotp_v1.integration.user-restriction',
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
      refreshTokenHash: 'sha256-v1:' + 'a'.repeat(64),
      deviceLabel: 'Integration',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
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
      permission,
      permissionVersion: 1,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
    });
  };

  const createTarget = async () => {
    const user = await users.create({
      publicId: 'usr_23456789AB',
      username: `target_${randomUUID().slice(0, 8)}`,
      fullname: 'Target User',
      phone: `09${String(Date.now()).slice(-8)}`,
      email: `${randomUUID()}@user.test`,
      password: `$2b$12$${'b'.repeat(53)}`,
      status: 'active',
      isDeleted: false,
      restriction: null,
      version: 0,
      authzVersion: 0,
    });
    await authSessions.create([
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: randomUUID(),
        tokenVersion: 0,
        refreshTokenHash: `sha256-bcrypt-v1:${'c'.repeat(60)}`,
        deviceLabel: 'Device A',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        revokeReason: null,
      },
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: randomUUID(),
        tokenVersion: 0,
        refreshTokenHash: `sha256-bcrypt-v1:${'d'.repeat(60)}`,
        deviceLabel: 'Device B',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        revokeReason: null,
      },
    ]);
    return user;
  };

  const suspendInput = (
    actor: AdminUserRestrictionActor,
    idempotencyKey = 'restrict-user-20260817-0001',
  ): UpdateAdminUserRestrictionInput => ({
    actor,
    targetPublicId: 'usr_23456789AB',
    operation: AdminUserRestrictionOperation.APPLY,
    restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
    expectedVersion: 0,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    publicReasonCode: 'community_policy_review',
    reasonCode: 'moderation_policy',
    reasonNote: 'Reviewed evidence under the moderation policy',
    correlationId: 'restriction-20260817-0001',
    idempotencyKey,
  });

  it('commits restriction, authz increment, revoke-all, audit and outbox atomically', async () => {
    const actor = await createActor();
    await createTarget();

    const result = await service.updateRestriction(suspendInput(actor));
    expect(result).toMatchObject({
      user: {
        publicId: 'usr_23456789AB',
        version: 1,
        restriction: { type: UserRestrictionType.TEMPORARY_SUSPENSION },
      },
      revokedSessionCount: 2,
    });

    const [stored, activeSessions, revokedSessions, auditCount, outboxCount] =
      await Promise.all([
        users
          .findOne({ publicId: 'usr_23456789AB' })
          .select('+restriction +version +authzVersion')
          .lean()
          .exec(),
        authSessions.countDocuments({ revokedAt: null }),
        authSessions.countDocuments({
          revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
        }),
        audits.countDocuments({ action: AdminAuditAction.USER_SUSPENDED }),
        outbox.countDocuments({
          eventType: 'moderation.user.restriction_changed',
        }),
      ]);
    expect(stored).toMatchObject({ version: 1, authzVersion: 1 });
    expect(activeSessions).toBe(0);
    expect(revokedSessions).toBe(2);
    expect(auditCount).toBe(1);
    expect(outboxCount).toBe(1);
  });

  it('replays the same key and rejects the same key with a different payload', async () => {
    const actor = await createActor();
    await createTarget();
    const input = {
      ...suspendInput(actor),
      expiresAt: new Date(Date.now() + 2_500).toISOString(),
    };
    const first = await service.updateRestriction(input);
    const replay = await service.updateRestriction(input);
    expect(replay).toEqual(first);
    await expect(
      service.updateRestriction({
        ...input,
        reasonNote: 'Reviewed different evidence under the moderation policy',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await requests.countDocuments({})).toBe(1);
    expect(
      await audits.countDocuments({ action: AdminAuditAction.USER_SUSPENDED }),
    ).toBe(1);
    expect(await outbox.countDocuments({})).toBe(1);

    const waitMs = Math.max(
      0,
      new Date(input.expiresAt).getTime() - Date.now() + 100,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await expect(service.updateRestriction(input)).resolves.toEqual(first);
    await expect(
      service.updateRestriction({
        ...input,
        idempotencyKey: 'restrict-expired-20260817-new',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes the matching restriction without reviving revoked sessions', async () => {
    const actor = await createActor();
    await createTarget();
    await service.updateRestriction(suspendInput(actor));

    const result = await service.updateRestriction({
      actor: {
        ...actor,
        permission: AdminPermission.USERS_UNSUSPEND,
      },
      targetPublicId: 'usr_23456789AB',
      operation: AdminUserRestrictionOperation.REMOVE,
      restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
      expectedVersion: 1,
      reasonCode: 'moderation_review_completed',
      reasonNote: 'Restriction review completed by the moderation operator',
      correlationId: 'unrestriction-20260817-0001',
      idempotencyKey: 'unrestrict-user-20260817-0001',
    });

    expect(result).toMatchObject({
      user: {
        publicId: 'usr_23456789AB',
        version: 2,
        restriction: null,
      },
      revokedSessionCount: 0,
    });

    const [stored, activeSessions, revokedSessions, unsuspendAudits, events] =
      await Promise.all([
        users
          .findOne({ publicId: 'usr_23456789AB' })
          .select('+restriction +version +authzVersion')
          .lean()
          .exec(),
        authSessions.countDocuments({ revokedAt: null }),
        authSessions.countDocuments({
          revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
        }),
        audits.countDocuments({ action: AdminAuditAction.USER_UNSUSPENDED }),
        outbox.countDocuments({
          eventType: 'moderation.user.restriction_changed',
        }),
      ]);
    expect(stored).toMatchObject({
      restriction: null,
      version: 2,
      authzVersion: 2,
    });
    expect(activeSessions).toBe(0);
    expect(revokedSessions).toBe(2);
    expect(unsuspendAudits).toBe(1);
    expect(events).toBe(2);
  });

  it('allows exactly one concurrent CAS winner', async () => {
    const actor = await createActor();
    await createTarget();
    const results = await Promise.allSettled([
      service.updateRestriction(
        suspendInput(actor, 'restrict-concurrent-20260817-a'),
      ),
      service.updateRestriction(
        suspendInput(actor, 'restrict-concurrent-20260817-b'),
      ),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await audits.countDocuments({ action: AdminAuditAction.USER_SUSPENDED }),
    ).toBe(1);
    expect(await outbox.countDocuments({})).toBe(1);
  });

  it('rolls back User, sessions, outbox and idempotency when audit fails', async () => {
    const actor = await createActor();
    await createTarget();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('AUDIT_FAILED'));

    await expect(
      service.updateRestriction(suspendInput(actor)),
    ).rejects.toThrow('AUDIT_FAILED');

    const stored = await users
      .findOne({ publicId: 'usr_23456789AB' })
      .select('+restriction +version +authzVersion')
      .lean()
      .exec();
    expect(stored).toMatchObject({
      restriction: null,
      version: 0,
      authzVersion: 0,
    });
    expect(await authSessions.countDocuments({ revokedAt: null })).toBe(2);
    expect(await outbox.countDocuments({})).toBe(0);
    expect(await requests.countDocuments({})).toBe(0);
  });
});
