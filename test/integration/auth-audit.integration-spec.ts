import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, createConnection, type Model, Types } from 'mongoose';
import type { IndexDescriptionInfo } from 'mongodb';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../../src/modules/auth/interfaces/auth-audit.interface';
import {
  AuthAuditEvent,
  AuthAuditEventSchema,
} from '../../src/modules/auth/schemas/auth-audit-event.schema';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';

const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const REQUIRED_CONFIRMATION = 'YES';

const DATABASE_PREFIX = 'betta_auth_audit_it_';

const databaseName = `${DATABASE_PREFIX}${process.pid}`;

const configService = {
  get: (key: string): unknown =>
    key === 'AUTH_AUDIT_RETENTION_DAYS' ? 180 : undefined,
} as ConfigService;

const FORBIDDEN_AUDIT_KEY_PATTERN = /password|otp|token|hash|secret/i;

const collectObjectKeys = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nestedValue]) => [key, ...collectObjectKeys(nestedValue)],
  );
};

const expectNoSensitiveFields = (value: unknown): void => {
  const leakedKeys = collectObjectKeys(value).filter((key) =>
    FORBIDDEN_AUDIT_KEY_PATTERN.test(key),
  );

  expect(leakedKeys).toEqual([]);
};

jest.setTimeout(60_000);

describe('Auth audit MongoDB integration', () => {
  let connection: Connection;
  let auditModel: Model<AuthAuditEvent>;
  let service: AuthAuditService;

  const targetUserId = new Types.ObjectId();

  const validDocument = () => ({
    eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
    targetUserId: new Types.ObjectId(),
    actorUserId: null,
    metadata: {
      affectedSessionCount: 2,
    },
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  beforeAll(async () => {
    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(
        `${CONFIRMATION_ENV}=${REQUIRED_CONFIRMATION} is required`,
      );
    }

    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} is required`);
    }

    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Unsafe integration database name');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Refusing database: ${connection.name}`);
    }

    auditModel = connection.model<AuthAuditEvent>(
      AuthAuditEvent.name,
      AuthAuditEventSchema,
    );

    await auditModel.syncIndexes();

    service = new AuthAuditService(auditModel, configService);
  });

  beforeEach(async () => {
    // Native access is intentional because
    // Mongoose mutations are append-only.
    await auditModel.collection.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();

      throw new Error(`Refusing unsafe database deletion: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('inserts a strict allowlisted audit event', async () => {
    await service.record({
      eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
      targetUserId,
      metadata: {
        affectedSessionCount: 2,
      },
    });

    const stored = await auditModel.collection.findOne({
      targetUserId,
    });

    expect(stored).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
        targetUserId,
        actorUserId: null,
        metadata: {
          affectedSessionCount: 2,
        },
        occurredAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    );

    expectNoSensitiveFields(stored);
  });

  it('rejects unknown top-level and nested fields', async () => {
    await expect(
      Promise.resolve().then(() =>
        auditModel.create({
          ...validDocument(),
          unexpectedField: true,
        } as unknown as AuthAuditEvent),
      ),
    ).rejects.toThrow();

    await expect(
      Promise.resolve().then(() =>
        auditModel.create({
          ...validDocument(),
          metadata: {
            affectedSessionCount: 2,
            token: 'forbidden',
          },
        } as unknown as AuthAuditEvent),
      ),
    ).rejects.toThrow();
  });

  it('enforces schema enum and session format', async () => {
    await expect(
      auditModel.create({
        ...validDocument(),
        outcome: 'invalid',
      } as unknown as AuthAuditEvent),
    ).rejects.toThrow();

    await expect(
      auditModel.create({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
        targetUserId,
        actorUserId: null,
        sessionPublicId: 'invalid',
        expiresAt: new Date(Date.now() + 86_400_000),
      } as AuthAuditEvent),
    ).rejects.toThrow();
  });

  it('blocks document, query and bulk mutations', async () => {
    await service.record({
      eventCode: AuthAuditEventCode.OAUTH_LINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
      targetUserId,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
    });

    const document = await auditModel.findOne({
      targetUserId,
    });

    if (!document) {
      throw new Error('Audit fixture was not created');
    }

    await expect(document.save()).rejects.toThrow(
      'Auth audit events are append-only',
    );

    await expect(document.deleteOne()).rejects.toThrow(
      'Auth audit events are append-only',
    );

    const mutations: Array<() => Promise<unknown>> = [
      () =>
        auditModel
          .updateOne(
            { _id: document._id },
            {
              $set: {
                outcome: AuthAuditOutcome.DENIED,
              },
            },
          )
          .exec(),

      () =>
        auditModel
          .updateMany(
            { targetUserId },
            {
              $set: {
                outcome: AuthAuditOutcome.DENIED,
              },
            },
          )
          .exec(),

      () =>
        auditModel
          .deleteOne({
            _id: document._id,
          })
          .exec(),

      () =>
        auditModel
          .deleteMany({
            targetUserId,
          })
          .exec(),

      () =>
        auditModel
          .findOneAndUpdate(
            { _id: document._id },
            {
              $set: {
                outcome: AuthAuditOutcome.DENIED,
              },
            },
          )
          .exec(),

      () =>
        auditModel
          .findOneAndDelete({
            _id: document._id,
          })
          .exec(),

      () =>
        auditModel.replaceOne({ _id: document._id }, validDocument()).exec(),

      () =>
        auditModel
          .findOneAndReplace({ _id: document._id }, validDocument())
          .exec(),
    ];

    for (const mutation of mutations) {
      await expect(mutation()).rejects.toThrow(
        'Auth audit events are append-only',
      );
    }

    await expect(
      auditModel.bulkWrite([
        {
          updateOne: {
            filter: {
              _id: document._id,
            },
            update: {
              $set: {
                outcome: AuthAuditOutcome.DENIED,
              },
            },
          },
        },
      ]),
    ).rejects.toThrow('Auth audit events are append-only');

    expect(
      await auditModel.countDocuments({
        targetUserId,
      }),
    ).toBe(1);
  });

  it('commits audit events with their transaction', async () => {
    await connection.transaction(async (mongoSession) => {
      await service.record({
        eventCode: AuthAuditEventCode.ACCOUNT_DELETED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.ACCOUNT_DELETION_COMPLETED,
        targetUserId,
        metadata: {
          affectedSessionCount: 3,
        },
        mongoSession,
      });
    });

    expect(
      await auditModel.countDocuments({
        targetUserId,
      }),
    ).toBe(1);
  });

  it('rolls back audit events with their transaction', async () => {
    const rollbackError = new Error('intentional transaction rollback');

    await expect(
      connection.transaction(async (mongoSession) => {
        await service.record({
          eventCode: AuthAuditEventCode.PASSWORD_RESET,
          outcome: AuthAuditOutcome.SUCCEEDED,
          reasonCode: AuthAuditReasonCode.PASSWORD_RESET_COMPLETED,
          targetUserId,
          metadata: {
            affectedSessionCount: 4,
          },
          mongoSession,
        });

        throw rollbackError;
      }),
    ).rejects.toBe(rollbackError);

    expect(
      await auditModel.countDocuments({
        targetUserId,
      }),
    ).toBe(0);
  });

  it('creates required TTL and query indexes', async () => {
    const rawIndexes: unknown = await auditModel.collection
      .listIndexes()
      .toArray();

    if (!Array.isArray(rawIndexes)) {
      throw new Error('MongoDB returned an invalid index list');
    }

    const indexes = rawIndexes as IndexDescriptionInfo[];

    const indexesByName = new Map<string, IndexDescriptionInfo>(
      indexes.flatMap(
        (index): Array<[string, IndexDescriptionInfo]> =>
          typeof index.name === 'string' ? [[index.name, index]] : [],
      ),
    );

    expect(indexesByName.get('expiresAt_ttl')).toEqual(
      expect.objectContaining({
        key: {
          expiresAt: 1,
        },
        expireAfterSeconds: 0,
      }),
    );

    expect(indexesByName.get('targetUserId_1_occurredAt_-1')?.key).toEqual({
      targetUserId: 1,
      occurredAt: -1,
    });

    expect(indexesByName.get('actorUserId_1_occurredAt_-1')).toEqual(
      expect.objectContaining({
        key: {
          actorUserId: 1,
          occurredAt: -1,
        },
        partialFilterExpression: {
          actorUserId: {
            $type: 'objectId',
          },
        },
      }),
    );

    expect(indexesByName.get('eventCode_1_occurredAt_-1')?.key).toEqual({
      eventCode: 1,
      occurredAt: -1,
    });

    expect(
      indexesByName.get('targetUserId_1_eventCode_1_occurredAt_-1')?.key,
    ).toEqual({
      targetUserId: 1,
      eventCode: 1,
      occurredAt: -1,
    });
  });
});
