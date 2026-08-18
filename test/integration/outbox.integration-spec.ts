import { randomUUID } from 'node:crypto';
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
import { createConnection, type Connection, type Model } from 'mongoose';
import {
  OUTBOX_CLAIM_INDEX,
  OUTBOX_DEDUPE_INDEX,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_INDEX,
  OutboxStatus,
} from '../../src/common/outbox/outbox.constants';
import {
  OutboxEvent,
  OutboxEventSchema,
} from '../../src/common/outbox/outbox-event.schema';
import { OutboxHandlerRegistry } from '../../src/common/outbox/outbox-handler.registry';
import { OutboxProcessorService } from '../../src/common/outbox/outbox-processor.service';
import { OutboxService } from '../../src/common/outbox/outbox.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_outbox_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID().replace(/-/gu, '').slice(0, 8)}`;

jest.setTimeout(90_000);

describe('Transactional outbox MongoDB integration', () => {
  let connection: Connection;
  let model: Model<OutboxEvent>;
  let outbox: OutboxService;
  let registry: OutboxHandlerRegistry;

  const enqueue = async (
    overrides: Partial<Parameters<OutboxService['enqueue']>[0]> = {},
  ): Promise<string> => {
    const session = await connection.startSession();
    try {
      let publicId = '';
      await session.withTransaction(async () => {
        publicId = await outbox.enqueue({
          eventType: 'notification.test_requested',
          dedupeKey: `notification.test:${randomUUID()}`,
          aggregateType: 'user',
          aggregatePublicId: 'usr_23456789AB',
          payload: { userPublicId: 'usr_23456789AB', action: 'TEST' },
          mongoSession: session,
          ...overrides,
        });
      });
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
    if ([process.env.DATABASE_URL, process.env.MONGODB_URI].includes(uri)) {
      throw new Error('Integration URI không được trùng runtime URI');
    }
    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();
    model = connection.model(OutboxEvent.name, OutboxEventSchema.clone());
    await model.syncIndexes();
    outbox = new OutboxService(model);
    registry = new OutboxHandlerRegistry();
  });

  beforeEach(async () => {
    await model.collection.deleteMany({});
    registry = new OutboxHandlerRegistry();
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

  it('creates unique dedupe, claim and TTL indexes', async () => {
    type ListedIndex = Readonly<{
      name: string;
      unique?: boolean;
      expireAfterSeconds?: number;
    }>;
    const indexes = (await model.collection
      .listIndexes()
      .toArray()) as unknown as ListedIndex[];
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get(OUTBOX_DEDUPE_INDEX)?.unique).toBe(true);
    expect(byName.has(OUTBOX_CLAIM_INDEX)).toBe(true);
    expect(byName.get(OUTBOX_RETENTION_INDEX)?.expireAfterSeconds).toBe(0);
  });

  it('rolls back the event with its owning business transaction', async () => {
    const session = await connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await outbox.enqueue({
            eventType: 'notification.test_requested',
            dedupeKey: `notification.test:${randomUUID()}`,
            aggregateType: 'user',
            aggregatePublicId: 'usr_23456789AB',
            payload: { action: 'TEST' },
            mongoSession: session,
          });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
    } finally {
      await session.endSession();
    }
    await expect(model.countDocuments({})).resolves.toBe(0);
  });

  it('rejects enqueue when the supplied session has no active transaction', async () => {
    const session = await connection.startSession();
    try {
      await expect(
        outbox.enqueue({
          eventType: 'notification.test_requested',
          dedupeKey: `notification.test:${randomUUID()}`,
          aggregateType: 'user',
          aggregatePublicId: 'usr_23456789AB',
          payload: { action: 'TEST' },
          mongoSession: session,
        }),
      ).rejects.toThrow('transaction đang active');
    } finally {
      await session.endSession();
    }

    await expect(model.countDocuments({})).resolves.toBe(0);
  });

  it('rejects unsafe payload before persistence', async () => {
    await expect(
      enqueue({ payload: { accessToken: 'do-not-store' } }),
    ).rejects.toThrow('field bị cấm');
    await expect(model.countDocuments({})).resolves.toBe(0);
  });

  it('allows one lease winner and publishes once under concurrent workers', async () => {
    const publicId = await enqueue();
    let calls = 0;
    registry.register({
      eventType: 'notification.test_requested',
      handle: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    const first = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
    const second = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
    await Promise.all([first.drain(1), second.drain(1)]);

    expect(calls).toBe(1);
    await expect(
      model.findOne({ publicId }).lean().exec(),
    ).resolves.toMatchObject({
      status: OutboxStatus.PUBLISHED,
      attempt: 1,
      leaseId: null,
    });
  });

  it('reclaims an expired lease with the same event identity', async () => {
    const publicId = await enqueue();
    const firstClaimAt = new Date(Date.now() + 1_000);
    const first = await outbox.claim(firstClaimAt, 1_000);

    expect(first?.event).toMatchObject({ publicId, attempt: 1 });

    const second = await outbox.claim(
      new Date(firstClaimAt.getTime() + 1_001),
      1_000,
    );

    expect(second?.leaseId).not.toBe(first?.leaseId);
    expect(second?.event).toMatchObject({
      publicId,
      dedupeKey: first?.event.dedupeKey,
      attempt: 2,
    });
  });

  it('retries a failed handler and then publishes with the same idempotency key', async () => {
    const publicId = await enqueue();
    const receivedKeys: string[] = [];
    let fail = true;
    registry.register({
      eventType: 'notification.test_requested',
      handle: (event) => {
        receivedKeys.push(event.dedupeKey);
        if (fail) {
          fail = false;
          return Promise.reject(
            Object.assign(new Error('temporary'), {
              code: 'TEMPORARY_FAILURE',
            }),
          );
        }
        return Promise.resolve();
      },
    });
    const processor = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
    await processor.drain(1);
    await model.collection.updateOne(
      { publicId },
      { $set: { availableAt: new Date(0) } },
    );
    await processor.drain(1);

    expect(receivedKeys).toHaveLength(2);
    expect(new Set(receivedKeys).size).toBe(1);
    await expect(
      model.findOne({ publicId }).lean().exec(),
    ).resolves.toMatchObject({
      status: OutboxStatus.PUBLISHED,
      attempt: 2,
    });
  });

  it('moves a poison event to dead letter without storing an error message', async () => {
    const publicId = await enqueue();
    await model.collection.updateOne(
      { publicId },
      { $set: { attempt: OUTBOX_MAX_ATTEMPTS - 1 } },
    );
    registry.register({
      eventType: 'notification.test_requested',
      handle: () =>
        Promise.reject(new Error('sensitive stack must not be persisted')),
    });
    const processor = new OutboxProcessorService(
      outbox,
      registry,
      new ConfigService(),
    );
    await processor.drain(1);
    const stored = await model.collection.findOne({ publicId });
    expect(stored).toMatchObject({
      status: OutboxStatus.DEAD_LETTER,
      attempt: OUTBOX_MAX_ATTEMPTS,
      lastErrorCode: 'HANDLER_FAILED',
    });
    expect(JSON.stringify(stored)).not.toContain('sensitive stack');
  });

  it('reports pending, processing, dead-letter and oldest pending metrics', async () => {
    const oldestPendingId = await enqueue();
    const processingId = await enqueue();
    const deadLetterId = await enqueue();
    const oldestAt = new Date('2026-08-15T00:00:00.000Z');

    await model.collection.updateOne(
      { publicId: oldestPendingId },
      { $set: { occurredAt: oldestAt } },
    );
    await model.collection.updateOne(
      { publicId: processingId },
      {
        $set: {
          status: OutboxStatus.PROCESSING,
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 30_000),
        },
      },
    );
    await model.collection.updateOne(
      { publicId: deadLetterId },
      {
        $set: {
          status: OutboxStatus.DEAD_LETTER,
          lastErrorCode: 'HANDLER_FAILED',
        },
      },
    );

    await expect(outbox.backlog()).resolves.toStrictEqual({
      pending: 1,
      processing: 1,
      deadLetter: 1,
      oldestPendingAt: oldestAt.toISOString(),
    });
  });
});
