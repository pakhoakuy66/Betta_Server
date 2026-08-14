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
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../../src/modules/admin/constants/admin-audit.constants';
import {
  ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS,
  ADMIN_LIFECYCLE_AUDIT_POLICY,
  type AdminLifecycleAuditAction,
  type AdminLifecycleAuditMetadataKey,
} from '../../src/modules/admin/constants/admin-lifecycle-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import {
  type AdminAuditActorInput,
  type AdminAuditMetadataInput,
  type RecordAdminAuditInput,
} from '../../src/modules/admin/interfaces/admin-audit.interface';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_al07_it_';
const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);
const ADMIN_PUBLIC_ID = 'adm_23456789ABCD';
const TARGET_ADMIN_PUBLIC_ID = 'adm_23456789ABCE';
const TARGET_SESSION_PUBLIC_ID = 'ases_23456789ABCDEFGH';
const SAFE_METADATA_VALUES: Readonly<
  Record<AdminLifecycleAuditMetadataKey, number | string>
> = Object.freeze({
  beforeVersion: 4,
  afterVersion: 5,
  beforeState: 'ACTIVE',
  afterState: 'LOCKED',
  affectedSessionCount: 2,
});

const PERMISSION_BY_ACTION: Readonly<
  Partial<Record<AdminLifecycleAuditAction, AdminPermission>>
> = Object.freeze({
  [AdminAuditAction.ADMIN_CREATED]: AdminPermission.ADMINS_CREATE,
  [AdminAuditAction.ADMIN_LOCKED]: AdminPermission.ADMINS_LOCK,
  [AdminAuditAction.ADMIN_UNLOCKED]: AdminPermission.ADMINS_UNLOCK,
  [AdminAuditAction.ADMIN_DELETED]: AdminPermission.ADMINS_DELETE,
  [AdminAuditAction.ADMIN_RESTORED]: AdminPermission.ADMINS_RESTORE,
});

type StoredLifecycleAudit = Readonly<{
  action: AdminAuditAction;
  actor: Readonly<{
    type: AdminAuditActorType;
    publicId?: string;
  }>;
  target: Readonly<{
    publicId: string;
  }>;
  reasonCode: string;
  correlationId?: string;
}>;

jest.setTimeout(90_000);

describe('Admin lifecycle audit MongoDB integration', () => {
  let connection: Connection;
  let auditModel: Model<AdminAuditEvent>;
  let service: AdminAuditService;

  const metadataFor = (
    action: AdminLifecycleAuditAction,
  ): AdminAuditMetadataInput | undefined => {
    const keys = ADMIN_LIFECYCLE_AUDIT_POLICY[action].requiredMetadata;
    if (keys.length === 0) return undefined;
    return Object.freeze(
      Object.fromEntries(keys.map((key) => [key, SAFE_METADATA_VALUES[key]])),
    ) as AdminAuditMetadataInput;
  };

  const actorFor = (
    action: AdminLifecycleAuditAction,
  ): AdminAuditActorInput => {
    if (action === AdminAuditAction.ACTIVATION_CONSUMED) {
      return Object.freeze({
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Admin activation workflow',
      });
    }
    const permission = PERMISSION_BY_ACTION[action];
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      publicId: ADMIN_PUBLIC_ID,
      username: 'superadmin.audit',
      displayName: 'Audit SuperAdmin',
      role: AdminRole.SUPER_ADMIN,
      ...(permission ? { permission } : {}),
      permissionVersion: 1,
    });
  };

  const inputFor = (
    action: AdminLifecycleAuditAction,
    index: number,
  ): RecordAdminAuditInput => ({
    action,
    outcome: AdminAuditOutcome.SUCCEEDED,
    actor: actorFor(action),
    target: {
      type: ADMIN_LIFECYCLE_AUDIT_POLICY[action].targetType,
      publicId:
        action === AdminAuditAction.SESSION_REVOKED
          ? TARGET_SESSION_PUBLIC_ID
          : TARGET_ADMIN_PUBLIC_ID,
    },
    reasonCode: 'lifecycle_contract_verified',
    metadata: metadataFor(action),
    correlationId: `life07_202608140000${String(index).padStart(2, '0')}`,
    source: AdminAuditSource.HTTP,
  });

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
    await connection.collection('lifecycle_audit_subjects').deleteMany({});
  });

  afterAll(async () => {
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

  it('stores every enabled lifecycle action with public IDs and safe diffs', async () => {
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const [
          index,
          action,
        ] of ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS.entries()) {
          await service.record({
            ...inputFor(action, index),
            mongoSession: session,
          });
        }
      });
    } finally {
      await session.endSession();
    }

    const stored = (await auditModel.collection
      .find({})
      .toArray()) as unknown as StoredLifecycleAudit[];
    expect(stored).toHaveLength(ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS.length);
    expect(new Set(stored.map((event) => event.action))).toEqual(
      new Set(ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS),
    );

    for (const event of stored) {
      expect(event.target.publicId).toMatch(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]+$/u);
      expect(event.reasonCode).toBe('lifecycle_contract_verified');
      expect(event.correlationId).toMatch(/^life07_/u);
      if (event.actor.type === AdminAuditActorType.ADMIN_ACCOUNT) {
        expect(event.actor.publicId).toBe(ADMIN_PUBLIC_ID);
      }
    }

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toMatch(
      /password|refreshToken|accessToken|totp|mfaSecret|recoveryCode|activationGrant/iu,
    );
    expect(serialized).not.toContain('raw-lifecycle-secret');
  });

  it('rolls back the mutation when mandatory audit validation fails', async () => {
    const session = await connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await connection
            .collection('lifecycle_audit_subjects')
            .insertOne(
              { publicId: TARGET_ADMIN_PUBLIC_ID, state: 'LOCKED' },
              { session },
            );
          await service.record({
            ...inputFor(AdminAuditAction.ADMIN_LOCKED, 99),
            reasonNote: 'Bearer raw-lifecycle-secret',
            mongoSession: session,
          });
        }),
      ).rejects.toThrow();
    } finally {
      await session.endSession();
    }

    await expect(
      connection.collection('lifecycle_audit_subjects').countDocuments({}),
    ).resolves.toBe(0);
    await expect(auditModel.countDocuments({})).resolves.toBe(0);
  });

  it('keeps runtime permission mutation disabled in Package A', () => {
    expect(ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS).not.toContain(
      AdminAuditAction.ADMIN_PERMISSIONS_UPDATED,
    );
    expect(AdminAuditTargetType.ADMIN_ACCOUNT).toBe('admin_account');
  });
});
