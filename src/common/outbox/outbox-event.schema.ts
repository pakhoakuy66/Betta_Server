import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';
import { nanoid } from 'nanoid';
import {
  OUTBOX_AGGREGATE_ID_PATTERN,
  OUTBOX_AGGREGATE_TYPE_PATTERN,
  OUTBOX_BACKLOG_INDEX,
  OUTBOX_CLAIM_INDEX,
  OUTBOX_COLLECTION,
  OUTBOX_CORRELATION_ID_PATTERN,
  OUTBOX_DEDUPE_INDEX,
  OUTBOX_DEDUPE_KEY_PATTERN,
  OUTBOX_EVENT_TYPE_PATTERN,
  OUTBOX_PUBLIC_ID_PATTERN,
  OUTBOX_RETENTION_INDEX,
  OUTBOX_SCHEMA_VERSION,
  OutboxStatus,
} from './outbox.constants';

const nonNegativeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Schema({
  collection: OUTBOX_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: { createdAt: 'occurredAt', updatedAt: 'updatedAt' },
})
export class OutboxEvent {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: () => `obx_${nanoid(22)}`,
    match: OUTBOX_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    default: OUTBOX_SCHEMA_VERSION,
    enum: [OUTBOX_SCHEMA_VERSION],
  })
  schemaVersion!: typeof OUTBOX_SCHEMA_VERSION;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_EVENT_TYPE_PATTERN,
  })
  eventType!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_DEDUPE_KEY_PATTERN,
  })
  dedupeKey!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_AGGREGATE_TYPE_PATTERN,
  })
  aggregateType!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_AGGREGATE_ID_PATTERN,
  })
  aggregatePublicId!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true, immutable: true })
  payload!: Readonly<Record<string, unknown>>;

  @Prop({
    type: String,
    immutable: true,
    match: OUTBOX_CORRELATION_ID_PATTERN,
  })
  correlationId?: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(OutboxStatus),
    default: OutboxStatus.PENDING,
  })
  status!: OutboxStatus;

  @Prop({ type: Date, required: true, default: Date.now })
  availableAt!: Date;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: { validator: nonNegativeInteger },
  })
  attempt!: number;

  @Prop({ type: String, default: null, maxlength: 64 })
  leaseId!: string | null;

  @Prop({ type: Date, default: null })
  leaseExpiresAt!: Date | null;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 64 })
  lastErrorCode!: string | null;

  @Prop({ type: Date, default: null })
  retentionExpiresAt!: Date | null;

  occurredAt!: Date;
  updatedAt!: Date;
}

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

OutboxEventSchema.index(
  { dedupeKey: 1 },
  { name: OUTBOX_DEDUPE_INDEX, unique: true },
);
OutboxEventSchema.index(
  { status: 1, availableAt: 1, leaseExpiresAt: 1, _id: 1 },
  { name: OUTBOX_CLAIM_INDEX },
);
OutboxEventSchema.index(
  { status: 1, occurredAt: 1 },
  { name: OUTBOX_BACKLOG_INDEX },
);
OutboxEventSchema.index(
  { retentionExpiresAt: 1 },
  {
    name: OUTBOX_RETENTION_INDEX,
    expireAfterSeconds: 0,
    partialFilterExpression: { retentionExpiresAt: { $type: 'date' } },
  },
);
