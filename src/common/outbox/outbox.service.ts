import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { isMongoInfrastructureError } from '../utils/is-mongo-infrastructure-error';
import {
  OUTBOX_AGGREGATE_ID_PATTERN,
  OUTBOX_AGGREGATE_TYPE_PATTERN,
  OUTBOX_CORRELATION_ID_PATTERN,
  OUTBOX_DEAD_LETTER_RETENTION_DAYS,
  OUTBOX_DEDUPE_KEY_PATTERN,
  OUTBOX_EVENT_TYPE_PATTERN,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_PAYLOAD_BYTES,
  OUTBOX_MAX_PAYLOAD_DEPTH,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  OutboxStatus,
} from './outbox.constants';
import type {
  ClaimedOutboxEvent,
  EnqueueOutboxEventInput,
  OutboxBacklogMetrics,
} from './outbox.interface';
import { OutboxEvent } from './outbox-event.schema';

const DAY_MS = 86_400_000;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|passcode|token|secret|credential|hash|evidence|internal.?reason|reason.?note|recovery/i;

type ClaimedDocument = OutboxEvent & { occurredAt: Date };

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxEvent.name)
    private readonly events: Model<OutboxEvent>,
  ) {}

  async enqueue(input: EnqueueOutboxEventInput): Promise<string> {
    if (input.mongoSession.inTransaction() !== true) {
      throw new TypeError(
        'Outbox enqueue yêu cầu MongoDB transaction đang active',
      );
    }
    this.validateEnvelope(input);
    const payload = this.cloneAndValidatePayload(input.payload);
    const result = await this.events.insertMany(
      [
        {
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          aggregateType: input.aggregateType,
          aggregatePublicId: input.aggregatePublicId,
          payload,
          ...(input.correlationId
            ? { correlationId: input.correlationId }
            : {}),
          availableAt: input.availableAt ?? new Date(),
        },
      ],
      { ordered: true, session: input.mongoSession },
    );
    const publicId = result[0]?.publicId;
    if (!publicId) throw new Error('Outbox insert không trả public ID');
    return publicId;
  }

  async claim(
    now: Date,
    leaseMs: number,
  ): Promise<{
    leaseId: string;
    event: ClaimedOutboxEvent;
  } | null> {
    const leaseId = randomUUID();
    try {
      const record = await this.events
        .findOneAndUpdate(
          {
            availableAt: { $lte: now },
            $or: [
              { status: OutboxStatus.PENDING },
              {
                status: OutboxStatus.PROCESSING,
                leaseExpiresAt: { $lte: now },
              },
            ],
          },
          {
            $set: {
              status: OutboxStatus.PROCESSING,
              leaseId,
              leaseExpiresAt: new Date(now.getTime() + leaseMs),
              lastErrorCode: null,
            },
            $inc: { attempt: 1 },
          },
          {
            sort: { availableAt: 1, _id: 1 },
            returnDocument: 'after',
            runValidators: true,
          },
        )
        .lean<ClaimedDocument | null>()
        .exec();
      return record ? { leaseId, event: this.toClaimed(record) } : null;
    } catch (error: unknown) {
      this.rethrowInfrastructure(error);
    }
  }

  async markPublished(
    publicId: string,
    leaseId: string,
    now: Date,
  ): Promise<void> {
    const result = await this.events.updateOne(
      { publicId, status: OutboxStatus.PROCESSING, leaseId },
      {
        $set: {
          status: OutboxStatus.PUBLISHED,
          publishedAt: now,
          retentionExpiresAt: new Date(
            now.getTime() + OUTBOX_PUBLISHED_RETENTION_DAYS * DAY_MS,
          ),
          leaseId: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        },
      },
    );
    if (result.modifiedCount !== 1) {
      throw new Error('Outbox lease không còn thuộc worker hiện tại');
    }
  }

  async markFailed(
    event: ClaimedOutboxEvent,
    leaseId: string,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const safeCode = ERROR_CODE_PATTERN.test(errorCode)
      ? errorCode
      : 'HANDLER_FAILED';
    const dead = event.attempt >= OUTBOX_MAX_ATTEMPTS;
    const retryDelayMs = Math.min(3_600_000, 1_000 * 2 ** (event.attempt - 1));
    const set: Record<string, unknown> = {
      status: dead ? OutboxStatus.DEAD_LETTER : OutboxStatus.PENDING,
      lastErrorCode: safeCode,
      availableAt: dead ? now : new Date(now.getTime() + retryDelayMs),
      ...(dead
        ? {
            retentionExpiresAt: new Date(
              now.getTime() + OUTBOX_DEAD_LETTER_RETENTION_DAYS * DAY_MS,
            ),
          }
        : {}),
    };
    const result = await this.events.updateOne(
      { publicId: event.publicId, status: OutboxStatus.PROCESSING, leaseId },
      { $set: { ...set, leaseId: null, leaseExpiresAt: null } },
    );
    if (result.modifiedCount !== 1) {
      throw new Error('Outbox lease không còn thuộc worker hiện tại');
    }
  }

  async backlog(): Promise<OutboxBacklogMetrics> {
    const [pending, processing, deadLetter, oldest] = await Promise.all([
      this.events.countDocuments({ status: OutboxStatus.PENDING }).exec(),
      this.events.countDocuments({ status: OutboxStatus.PROCESSING }).exec(),
      this.events.countDocuments({ status: OutboxStatus.DEAD_LETTER }).exec(),
      this.events
        .findOne({ status: OutboxStatus.PENDING })
        .sort({ occurredAt: 1 })
        .select('occurredAt')
        .lean<{ occurredAt: Date } | null>()
        .exec(),
    ]);
    return Object.freeze({
      pending,
      processing,
      deadLetter,
      oldestPendingAt: oldest?.occurredAt.toISOString() ?? null,
    });
  }

  private validateEnvelope(input: EnqueueOutboxEventInput): void {
    if (
      !OUTBOX_EVENT_TYPE_PATTERN.test(input.eventType) ||
      !OUTBOX_DEDUPE_KEY_PATTERN.test(input.dedupeKey) ||
      !OUTBOX_AGGREGATE_TYPE_PATTERN.test(input.aggregateType) ||
      !OUTBOX_AGGREGATE_ID_PATTERN.test(input.aggregatePublicId) ||
      (input.correlationId !== undefined &&
        !OUTBOX_CORRELATION_ID_PATTERN.test(input.correlationId)) ||
      (input.availableAt !== undefined &&
        Number.isNaN(input.availableAt.getTime()))
    ) {
      throw new TypeError('Outbox envelope không hợp lệ');
    }
  }

  private cloneAndValidatePayload(
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    this.validateValue(payload, 0);
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > OUTBOX_MAX_PAYLOAD_BYTES) {
      throw new TypeError('Outbox payload vượt giới hạn');
    }
    return JSON.parse(json) as Record<string, unknown>;
  }

  private validateValue(value: unknown, depth: number): void {
    if (depth > OUTBOX_MAX_PAYLOAD_DEPTH) {
      throw new TypeError('Outbox payload quá sâu');
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.validateValue(item, depth + 1));
      return;
    }
    if (!this.isPlainObject(value)) {
      throw new TypeError('Outbox payload chỉ hỗ trợ JSON an toàn');
    }
    for (const [key, nested] of Object.entries(value)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
        SENSITIVE_KEY_PATTERN.test(key)
      ) {
        throw new TypeError(`Outbox payload chứa field bị cấm: ${key}`);
      }
      this.validateValue(nested, depth + 1);
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  }

  private toClaimed(record: ClaimedDocument): ClaimedOutboxEvent {
    return Object.freeze({
      publicId: record.publicId,
      schemaVersion: record.schemaVersion,
      eventType: record.eventType,
      dedupeKey: record.dedupeKey,
      aggregateType: record.aggregateType,
      aggregatePublicId: record.aggregatePublicId,
      payload: Object.freeze(record.payload),
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
      attempt: record.attempt,
      occurredAt: record.occurredAt,
    });
  }

  private rethrowInfrastructure(error: unknown): never {
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException('Outbox tạm thời không khả dụng');
    }
    throw error;
  }
}
