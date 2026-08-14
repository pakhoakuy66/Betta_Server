import { randomUUID } from 'node:crypto';
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
import { createAdminPolicy } from '../../src/modules/admin/config/admin-policy.config';
import { AdminRole } from '../../src/modules/admin/constants/admin-account.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import {
  ADMIN_AUDIT_RETENTION_DAYS,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import {
  ADMIN_AUDIT_ACTION_INDEX,
  ADMIN_AUDIT_COLLECTION,
  ADMIN_AUDIT_PUBLIC_ID_INDEX,
  ADMIN_AUDIT_RETENTION_INDEX,
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_admin_audit_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

jest.setTimeout(90_000);

describe('Admin audit store MongoDB integration', () => {
  let connection: Connection;
  let auditModel: Model<AdminAuditEvent>;
  let service: AdminAuditService;

  const input = () => ({
    action: AdminAuditAction.ADMIN_LOCKED,
    outcome: AdminAuditOutcome.SUCCEEDED,
    actor: {
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: 'adm_23456789ABCD',
      username: 'owner',
      displayName: 'Owner',
      role: AdminRole.SUPER_ADMIN,
      permission: AdminPermission.ADMINS_LOCK,
      permissionVersion: 1,
    },
    target: {
      type: AdminAuditTargetType.ADMIN_ACCOUNT,
      publicId: 'adm_23456789ABCE',
    },
    reasonCode: 'security_review',
    metadata: {
      beforeVersion: 1,
      afterVersion: 2,
      beforeState: 'ACTIVE',
      afterState: 'LOCKED',
      affectedSessionCount: 1,
    },
    source: AdminAuditSource.HTTP,
  });

  const recordAudit = async (): Promise<string> => {
    const session = await connection.startSession();
    try {
      let publicId: string | undefined;
      await session.withTransaction(async () => {
        publicId = await service.record({ ...input(), mongoSession: session });
      });
      if (!publicId) throw new Error('Transaction không trả audit public ID');
      return publicId;
    } finally {
      await session.endSession();
    }
  };

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

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();
    auditModel = connection.model(
      AdminAuditEvent.name,
      AdminAuditEventSchema.clone(),
    );
    await auditModel.syncIndexes();
    service = new AdminAuditService(
      auditModel,
      createAdminPolicy({ get: () => undefined }),
    );
  });

  beforeEach(async () => {
    await auditModel.collection.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Từ chối xóa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('creates the unique, TTL and action query indexes', async () => {
    type ListedIndex = Readonly<{
      name: string;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    const indexes = (await auditModel.collection
      .listIndexes()
      .toArray()) as unknown as ListedIndex[];
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(auditModel.collection.collectionName).toBe(ADMIN_AUDIT_COLLECTION);
    expect(byName.get(ADMIN_AUDIT_PUBLIC_ID_INDEX)?.unique).toBe(true);
    expect(byName.get(ADMIN_AUDIT_RETENTION_INDEX)?.expireAfterSeconds).toBe(0);
    expect(byName.has(ADMIN_AUDIT_ACTION_INDEX)).toBe(true);
  });

  it('stores only approved fields and a 365-day retention boundary', async () => {
    const before = Date.now();
    const publicId = await recordAudit();
    const after = Date.now();
    const stored = await auditModel.collection.findOne({ publicId });

    expect(stored).toBeTruthy();
    expect(stored).not.toHaveProperty('password');
    expect(stored).not.toHaveProperty('refreshToken');
    const expiry = (stored?.expiresAt as Date).getTime();
    const retentionMs = ADMIN_AUDIT_RETENTION_DAYS * 86_400_000;
    expect(expiry).toBeGreaterThanOrEqual(before + retentionMs);
    expect(expiry).toBeLessThanOrEqual(after + retentionMs);
  });

  it('rejects a session that exists without an active transaction', async () => {
    const session = await connection.startSession();
    try {
      await expect(
        service.record({ ...input(), mongoSession: session }),
      ).rejects.toThrow('transaction đang active');
    } finally {
      await session.endSession();
    }

    await expect(auditModel.countDocuments({})).resolves.toBe(0);
  });

  it.each(['updateOne', 'deleteOne'] as const)(
    'rejects application-level %s mutation',
    async (operation) => {
      const publicId = await recordAudit();
      const query =
        operation === 'updateOne'
          ? auditModel.updateOne(
              { publicId },
              { $set: { reasonCode: 'changed' } },
            )
          : auditModel.deleteOne({ publicId });

      await expect(query.exec()).rejects.toThrow(
        'Admin audit events are append-only',
      );
      await expect(auditModel.countDocuments({ publicId })).resolves.toBe(1);
    },
  );

  it('uses the approved action index for filtered timeline queries', async () => {
    await recordAudit();
    const explain = (await auditModel.collection
      .find({ action: AdminAuditAction.ADMIN_LOCKED })
      .sort({ occurredAt: -1, publicId: 1 })
      .hint(ADMIN_AUDIT_ACTION_INDEX)
      .explain('queryPlanner')) as unknown;
    expect(JSON.stringify(explain)).toContain(ADMIN_AUDIT_ACTION_INDEX);
  });

  it('does not return logically expired records before TTL cleanup runs', async () => {
    await recordAudit();
    await auditModel.collection.updateOne(
      { action: AdminAuditAction.ADMIN_LOCKED },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    const result = await service.list({ page: 1, limit: 20 });
    expect(result.items).toEqual([]);
  });

  it('rolls back audit when the caller transaction fails', async () => {
    const session = await connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await service.record({ ...input(), mongoSession: session });
          throw new Error('force caller rollback');
        }),
      ).rejects.toThrow('force caller rollback');
    } finally {
      await session.endSession();
    }

    await expect(auditModel.countDocuments({})).resolves.toBe(0);
  });
});
