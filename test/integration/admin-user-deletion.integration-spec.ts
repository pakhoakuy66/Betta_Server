import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
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
import {
  ADMIN_USER_DELETION_EVENT_TYPE,
  AdminUserDeletionOperation,
} from '../../src/modules/admin/constants/admin-user-deletion.constants';
import type {
  AdminUserDeletionActor,
  UpdateAdminUserDeletionInput,
} from '../../src/modules/admin/interfaces/admin-user-deletion.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { AdminUserDeletionRequest } from '../../src/modules/admin/schemas/admin-user-deletion-request.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminUserDeletionService } from '../../src/modules/admin/services/admin-user-deletion.service';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import {
  UserDeletionOrigin,
  UserRestrictionType,
} from '../../src/modules/users/constants/user-moderation.constants';
import { User } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_usr_delete_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 6);

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `user-deletion-it-${String(index + 1)}`,
        keyBase64: Buffer.alloc(32, index + 71).toString('base64'),
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

describe('Admin User deletion MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let adminAccounts: Model<AdminAccount>;
  let adminSessions: Model<AdminSession>;
  let users: Model<User>;
  let authSessions: Model<AuthSession>;
  let audits: Model<AdminAuditEvent>;
  let outbox: Model<OutboxEvent>;
  let requests: Model<AdminUserDeletionRequest>;
  let service: AdminUserDeletionService;
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
    users = moduleRef.get(getModelToken(User.name));
    authSessions = moduleRef.get(getModelToken(AuthSession.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outbox = moduleRef.get(getModelToken(OutboxEvent.name));
    requests = moduleRef.get(getModelToken(AdminUserDeletionRequest.name));
    service = moduleRef.get(AdminUserDeletionService);
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
    permission: AdminPermission,
  ): Promise<AdminUserDeletionActor> => {
    const account = await adminAccounts.create({
      publicId: generateAdminPublicId(),
      email: `${randomUUID()}@betta.test`,
      username: `adm_${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
      displayName: 'Moderation Operator',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'atotp_v1.integration.user-deletion',
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
      role: AdminRole.ADMIN,
      permission,
      permissionVersion: 1,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
    });
  };

  const createTarget = async (overrides: Record<string, unknown> = {}) => {
    const user = await users.create({
      publicId: 'usr_23456789AB',
      username: `target_${randomUUID().slice(0, 8)}`,
      fullname: 'Target User',
      phone: `09${String(Date.now()).slice(-8)}`,
      email: `${randomUUID()}@user.test`,
      password: `$2b$12$${'b'.repeat(53)}`,
      bio: 'Preserve this profile',
      postsCount: 7,
      status: 'active',
      isDeleted: false,
      deletionOrigin: null,
      restorableUntil: null,
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
        effectiveAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
        supportReference: 'sup_23456789',
        publicReasonCode: 'policy_review',
      },
      version: 0,
      authzVersion: 0,
      ...overrides,
    });
    await authSessions.create([
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: `fam_${randomUUID()}`,
        tokenVersion: 0,
        refreshTokenHash: 'hash-one',
        deviceLabel: 'One',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: `fam_${randomUUID()}`,
        tokenVersion: 0,
        refreshTokenHash: 'hash-two',
        deviceLabel: 'Two',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    return user;
  };

  const input = (
    actor: AdminUserDeletionActor,
    operation: AdminUserDeletionOperation,
    expectedVersion: number,
    key = randomUUID(),
  ): UpdateAdminUserDeletionInput => ({
    actor,
    targetPublicId: 'usr_23456789AB',
    operation,
    expectedVersion,
    reasonCode: 'moderation_policy',
    reasonNote: 'Reviewed by moderation operator',
    correlationId: `user-deletion-${randomUUID()}`,
    idempotencyKey: key,
  });

  it('deletes and restores atomically without cleanup or session revival', async () => {
    const actor = await createActor(AdminPermission.USERS_SOFT_DELETE);
    const target = await createTarget();

    const deleted = await service.updateDeletion(
      input(actor, AdminUserDeletionOperation.DELETE, 0),
    );
    expect(deleted).toMatchObject({
      user: {
        version: 1,
        deletion: {
          isDeleted: true,
          origin: UserDeletionOrigin.ADMIN_MODERATION,
        },
      },
      revokedSessionCount: 2,
    });

    const storedDeleted = await users
      .findById(target._id)
      .select(
        '+deletionOrigin +restorableUntil +restriction +version +authzVersion',
      )
      .lean();
    expect(storedDeleted).toMatchObject({
      isDeleted: true,
      deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
      version: 1,
      authzVersion: 1,
      bio: 'Preserve this profile',
      postsCount: 7,
      restriction: { type: UserRestrictionType.TEMPORARY_SUSPENSION },
    });
    expect(
      await authSessions.countDocuments({
        userId: target._id,
        revokedAt: { $ne: null },
        revokeReason: SessionRevokeReason.ACCOUNT_DELETED,
      }),
    ).toBe(2);
    expect(
      await audits.countDocuments({ action: AdminAuditAction.USER_DELETED }),
    ).toBe(1);
    expect(
      await outbox.countDocuments({
        eventType: ADMIN_USER_DELETION_EVENT_TYPE,
        status: 'PENDING',
        attempt: 0,
      }),
    ).toBe(1);

    const restoreActor = await createActor(AdminPermission.USERS_RESTORE);
    const restored = await service.updateDeletion(
      input(restoreActor, AdminUserDeletionOperation.RESTORE, 1),
    );
    expect(restored).toMatchObject({
      user: {
        version: 2,
        deletion: {
          isDeleted: false,
          origin: null,
          deletedAt: null,
          restorableUntil: null,
        },
      },
      revokedSessionCount: 0,
    });
    const storedRestored = await users
      .findById(target._id)
      .select(
        '+deletionOrigin +restorableUntil +restriction +version +authzVersion',
      )
      .lean();
    expect(storedRestored).toMatchObject({
      isDeleted: false,
      deletionOrigin: null,
      restorableUntil: null,
      version: 2,
      authzVersion: 2,
      bio: 'Preserve this profile',
      postsCount: 7,
      restriction: { type: UserRestrictionType.TEMPORARY_SUSPENSION },
    });
    expect(storedRestored).not.toHaveProperty('deletedAt');
    expect(await authSessions.countDocuments({ revokedAt: null })).toBe(0);
    expect(
      await audits.countDocuments({ action: AdminAuditAction.USER_RESTORED }),
    ).toBe(1);
    expect(await outbox.countDocuments({ status: 'PENDING' })).toBe(2);
  });

  it('rejects self-deleted and expired admin deletions without side effects', async () => {
    const actor = await createActor(AdminPermission.USERS_RESTORE);
    await createTarget({
      isDeleted: true,
      deletedAt: new Date(Date.now() - 60_000),
      deletionOrigin: UserDeletionOrigin.USER_SELF_DELETED,
      restorableUntil: null,
    });
    await expect(
      service.updateDeletion(
        input(actor, AdminUserDeletionOperation.RESTORE, 0),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await requests.countDocuments()).toBe(0);
    expect(await outbox.countDocuments()).toBe(0);
    expect(await audits.countDocuments()).toBe(0);

    await users.updateOne(
      { publicId: 'usr_23456789AB' },
      {
        $set: {
          deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
          restorableUntil: new Date(Date.now() - 1_000),
        },
      },
    );
    await expect(
      service.updateDeletion(
        input(actor, AdminUserDeletionOperation.RESTORE, 0),
      ),
    ).rejects.toThrow('Thời hạn khôi phục User đã kết thúc');
  });

  it('replays one key and rejects the same key for another payload', async () => {
    const actor = await createActor(AdminPermission.USERS_SOFT_DELETE);
    await createTarget();
    const key = randomUUID();
    const request = input(actor, AdminUserDeletionOperation.DELETE, 0, key);

    const first = await service.updateDeletion(request);
    await expect(service.updateDeletion(request)).resolves.toEqual(first);
    await expect(
      service.updateDeletion({ ...request, reasonNote: 'Different payload' }),
    ).rejects.toThrow('Idempotency-Key đã được dùng cho payload khác');
    expect(await requests.countDocuments()).toBe(1);
    expect(await audits.countDocuments()).toBe(1);
    expect(await outbox.countDocuments()).toBe(1);
  });

  it('allows exactly one concurrent CAS winner', async () => {
    const actor = await createActor(AdminPermission.USERS_SOFT_DELETE);
    await createTarget();
    const settled = await Promise.allSettled([
      service.updateDeletion(
        input(actor, AdminUserDeletionOperation.DELETE, 0),
      ),
      service.updateDeletion(
        input(actor, AdminUserDeletionOperation.DELETE, 0),
      ),
    ]);
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await requests.countDocuments()).toBe(1);
    expect(await audits.countDocuments()).toBe(1);
    expect(await outbox.countDocuments()).toBe(1);
  });

  it('rolls back User, sessions, outbox and request when audit fails', async () => {
    const actor = await createActor(AdminPermission.USERS_SOFT_DELETE);
    const target = await createTarget();
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(
        new ServiceUnavailableException('audit unavailable'),
      );

    await expect(
      service.updateDeletion(
        input(actor, AdminUserDeletionOperation.DELETE, 0),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const stored = await users
      .findById(target._id)
      .select('+deletionOrigin +restorableUntil +version +authzVersion')
      .lean();
    expect(stored).toMatchObject({
      isDeleted: false,
      deletionOrigin: null,
      restorableUntil: null,
      version: 0,
      authzVersion: 0,
    });
    expect(await authSessions.countDocuments({ revokedAt: null })).toBe(2);
    expect(await requests.countDocuments()).toBe(0);
    expect(await outbox.countDocuments()).toBe(0);
    expect(await audits.countDocuments()).toBe(0);
  });
});
