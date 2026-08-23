import { randomUUID } from 'node:crypto';
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
import { type Connection, type Model } from 'mongoose';
import { OutboxEvent } from '../../src/common/outbox/outbox-event.schema';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { AdminModule } from '../../src/modules/admin/admin.module';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditSource,
} from '../../src/modules/admin/constants/admin-audit.constants';
import type { AdminUserRestrictionExpiryCandidate } from '../../src/modules/admin/interfaces/admin-user-restriction-expiry.interface';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service';
import { AdminUserRestrictionExpiryService } from '../../src/modules/admin/services/admin-user-restriction-expiry.service';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import { User } from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_usr_expiry_it_';
const databaseName =
  DATABASE_PREFIX +
  String(process.pid) +
  '_' +
  randomUUID().replace(/-/gu, '').slice(0, 6);
const NOW = new Date('2026-08-23T12:00:00.000Z');

const SECRET_VALUES = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: 'user-expiry-it-' + String(index + 1),
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

describe('Admin User restriction expiry MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let users: Model<User>;
  let sessions: Model<AuthSession>;
  let audits: Model<AdminAuditEvent>;
  let outboxEvents: Model<OutboxEvent>;
  let service: AdminUserRestrictionExpiryService;
  let audit: AdminAuditService;
  let outbox: OutboxService;
  let sequence = 0;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(URI_ENV + ' chua duoc cau hinh');
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(CONFIRM_ENV + '=YES la bat buoc');
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
    users = moduleRef.get(getModelToken(User.name));
    sessions = moduleRef.get(getModelToken(AuthSession.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outboxEvents = moduleRef.get(getModelToken(OutboxEvent.name));
    service = moduleRef.get(AdminUserRestrictionExpiryService);
    audit = moduleRef.get(AdminAuditService);
    outbox = moduleRef.get(OutboxService);

    await Promise.all([
      users.syncIndexes(),
      sessions.syncIndexes(),
      audits.syncIndexes(),
      outboxEvents.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    sequence = 0;
    await Promise.all([
      users.deleteMany({}),
      sessions.deleteMany({}),
      audits.collection.deleteMany({}),
      outboxEvents.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error('Tu choi xoa database: ' + connection.name);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const createUser = async (input: {
    type: UserRestrictionType;
    expiresAt: Date | null;
    version?: number;
    authzVersion?: number;
  }) => {
    sequence += 1;
    return users.create({
      publicId: generateUserPublicId(),
      username: 'expiry_' + String(sequence) + '_' + randomUUID().slice(0, 6),
      fullname: 'Expiry Target ' + String(sequence),
      phone: '08' + String(10_000_000 + sequence),
      email: randomUUID() + '@expiry.test',
      password: '$2b$12$' + 'b'.repeat(53),
      status: 'active',
      isDeleted: false,
      restriction: {
        type: input.type,
        effectiveAt: new Date(NOW.getTime() - 60_000),
        expiresAt: input.expiresAt,
        supportReference: 'sup_' + randomUUID().replace(/-/gu, '').slice(0, 20),
        publicReasonCode: 'community_policy_review',
      },
      version: input.version ?? 0,
      authzVersion: input.authzVersion ?? 0,
    });
  };

  const createSession = async (
    userId: User['_id'],
    label: string,
    revokedAt: Date | null = null,
  ) =>
    sessions.create({
      userId,
      publicId: 'ses_' + randomUUID(),
      tokenFamily: randomUUID(),
      tokenVersion: 0,
      refreshTokenHash: 'sha256-bcrypt-v1:' + label.repeat(60).slice(0, 60),
      deviceLabel: 'Expiry ' + label,
      lastUsedAt: new Date(NOW.getTime() - 1_000),
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      revokedAt,
      revokeReason: revokedAt ? SessionRevokeReason.LOGOUT : null,
    });

  const candidateFor = async (
    userId: User['_id'],
  ): Promise<AdminUserRestrictionExpiryCandidate> => {
    const candidate = await users
      .findById(userId)
      .select('_id publicId fullname +version +restriction')
      .lean<AdminUserRestrictionExpiryCandidate | null>()
      .exec();
    if (!candidate) throw new Error('Expiry candidate khong ton tai');
    return candidate;
  };

  it('expires only due temporary restrictions and commits all side effects', async () => {
    const due = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() - 1),
      version: 3,
      authzVersion: 5,
    });
    const future = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const indefinite = await createUser({
      type: UserRestrictionType.INDEFINITE_BAN,
      expiresAt: null,
    });
    await Promise.all([
      createSession(due._id, 'a'),
      createSession(due._id, 'b'),
    ]);

    await expect(service.expireDueRestrictions(NOW)).resolves.toEqual({
      scanned: 1,
      expired: 1,
      skipped: 0,
      failed: 0,
    });

    const [
      storedDue,
      storedFuture,
      storedIndefinite,
      activeSessions,
      auditDoc,
      event,
    ] = await Promise.all([
      users
        .findById(due._id)
        .select('+restriction +version +authzVersion')
        .lean()
        .exec(),
      users.findById(future._id).select('+restriction +version').lean().exec(),
      users
        .findById(indefinite._id)
        .select('+restriction +version')
        .lean()
        .exec(),
      sessions.countDocuments({ userId: due._id, revokedAt: null }),
      audits
        .findOne({ action: AdminAuditAction.USER_UNSUSPENDED })
        .lean()
        .exec(),
      outboxEvents
        .findOne({
          aggregatePublicId: due.publicId,
          eventType: 'moderation.user.restriction_changed',
        })
        .lean()
        .exec(),
    ]);

    expect(storedDue).toMatchObject({
      restriction: null,
      version: 4,
      authzVersion: 6,
    });
    expect(storedFuture?.restriction).toMatchObject({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
    });
    expect(storedIndefinite?.restriction).toMatchObject({
      type: UserRestrictionType.INDEFINITE_BAN,
    });
    expect(activeSessions).toBe(0);
    expect(
      await sessions.countDocuments({
        userId: due._id,
        revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
      }),
    ).toBe(2);
    expect(auditDoc).toMatchObject({
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Betta restriction expiry worker',
      },
      source: AdminAuditSource.WORKER,
      reasonCode: 'restriction_expired',
      metadata: {
        beforeVersion: 3,
        afterVersion: 4,
        affectedSessionCount: 2,
      },
    });
    expect(event).toMatchObject({
      dedupeKey: 'user-restriction:' + due.publicId + ':4',
      payload: {
        operation: 'REMOVE',
        restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
        restriction: null,
        beforeVersion: 3,
        afterVersion: 4,
      },
    });
  });

  it('allows exactly one CAS winner across service instances', async () => {
    const user = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const candidate = await candidateFor(user._id);
    const first = new AdminUserRestrictionExpiryService(
      users,
      sessions,
      connection,
      audit,
      outbox,
      () => NOW,
    );
    const second = new AdminUserRestrictionExpiryService(
      users,
      sessions,
      connection,
      audit,
      outbox,
      () => NOW,
    );

    const results = await Promise.all([
      first.expireCandidate(candidate, NOW),
      second.expireCandidate(candidate, NOW),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await audits.countDocuments({})).toBe(1);
    expect(await outboxEvents.countDocuments({})).toBe(1);
    expect(
      await users
        .findById(user._id)
        .select('+version')
        .lean<{ version: number } | null>()
        .exec(),
    ).toMatchObject({ version: 1 });
  });

  it('does not clear a newer restriction from a stale candidate', async () => {
    const user = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() - 1),
      version: 2,
      authzVersion: 4,
    });
    const stale = await candidateFor(user._id);
    const newerExpiry = new Date(NOW.getTime() + 86_400_000);

    await users.updateOne(
      { _id: user._id, version: 2 },
      {
        $set: {
          'restriction.expiresAt': newerExpiry,
          'restriction.effectiveAt': NOW,
        },
        $inc: { version: 1, authzVersion: 1 },
      },
    );

    await expect(service.expireCandidate(stale, NOW)).resolves.toBeNull();

    const stored = await users
      .findById(user._id)
      .select('+restriction +version +authzVersion')
      .lean()
      .exec();
    expect(stored).toMatchObject({
      version: 3,
      authzVersion: 5,
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
        expiresAt: newerExpiry,
      },
    });
    expect(await audits.countDocuments({})).toBe(0);
    expect(await outboxEvents.countDocuments({})).toBe(0);
  });

  it('rolls back every side effect when audit fails and retries safely', async () => {
    const user = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() - 1),
      version: 6,
      authzVersion: 9,
    });
    await createSession(user._id, 'c');
    const candidate = await candidateFor(user._id);
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('AUDIT_FAILED'));

    await expect(service.expireCandidate(candidate, NOW)).rejects.toThrow(
      'AUDIT_FAILED',
    );

    expect(
      await users
        .findById(user._id)
        .select('+restriction +version +authzVersion')
        .lean()
        .exec(),
    ).toMatchObject({
      version: 6,
      authzVersion: 9,
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
      },
    });
    expect(
      await sessions.countDocuments({ userId: user._id, revokedAt: null }),
    ).toBe(1);
    expect(await audits.countDocuments({})).toBe(0);
    expect(await outboxEvents.countDocuments({})).toBe(0);

    await expect(
      service.expireCandidate(candidate, NOW),
    ).resolves.toMatchObject({
      beforeVersion: 6,
      afterVersion: 7,
      authzVersion: 10,
    });
    expect(
      await sessions.countDocuments({ userId: user._id, revokedAt: null }),
    ).toBe(0);
    expect(await audits.countDocuments({})).toBe(1);
    expect(await outboxEvents.countDocuments({})).toBe(1);
  });

  it('revokes old sessions before a new authentication session is inserted', async () => {
    const user = await createUser({
      type: UserRestrictionType.TEMPORARY_SUSPENSION,
      expiresAt: new Date(NOW.getTime() - 1),
      version: 10,
      authzVersion: 12,
    });
    const oldSession = await createSession(user._id, 'd');

    const result = await connection.transaction(async (mongoSession) => {
      const converged = await service.convergeForAuthentication(
        user._id,
        NOW,
        mongoSession,
      );
      const newSession = await sessions.create(
        [
          {
            userId: user._id,
            publicId: 'ses_' + randomUUID(),
            tokenFamily: randomUUID(),
            tokenVersion: 0,
            refreshTokenHash: 'sha256-bcrypt-v1:' + 'e'.repeat(60),
            deviceLabel: 'New login',
            lastUsedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 86_400_000),
            revokedAt: null,
            revokeReason: null,
          },
        ],
        { session: mongoSession },
      );
      return { converged, newSessionId: newSession[0]?._id };
    });

    expect(result.converged).toMatchObject({
      afterVersion: 11,
      authzVersion: 13,
      revokedSessionCount: 1,
    });
    expect(await sessions.findById(oldSession._id).lean().exec()).toMatchObject(
      {
        revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
      },
    );
    expect(
      await sessions.findById(result.newSessionId).lean().exec(),
    ).toMatchObject({
      revokedAt: null,
    });
  });
});
