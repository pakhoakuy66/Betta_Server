export const OUTBOX_COLLECTION = 'outbox_events' as const;
export const OUTBOX_SCHEMA_VERSION = 1 as const;
export const OUTBOX_PUBLIC_ID_PATTERN = /^obx_[A-Za-z0-9_-]{22}$/;
export const OUTBOX_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{2,95}$/;
export const OUTBOX_DEDUPE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/;
export const OUTBOX_AGGREGATE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
export const OUTBOX_AGGREGATE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{7,95}$/;
export const OUTBOX_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

export const OUTBOX_MAX_PAYLOAD_BYTES = 16_384;
export const OUTBOX_MAX_PAYLOAD_DEPTH = 6;
export const OUTBOX_DEFAULT_BATCH_SIZE = 25;
export const OUTBOX_MAX_BATCH_SIZE = 100;
export const OUTBOX_DEFAULT_LEASE_MS = 30_000;
export const OUTBOX_MIN_LEASE_MS = 3_000;
export const OUTBOX_MAX_LEASE_MS = 300_000;
export const OUTBOX_RECONCILIATION_BATCH_SIZE = 100;
export const OUTBOX_MAX_ATTEMPTS = 12;
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 30;
export const OUTBOX_DEAD_LETTER_RETENTION_DAYS = 90;

export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  DEAD_LETTER = 'DEAD_LETTER',
}

export const OUTBOX_CLAIM_INDEX = 'outbox_claim_v1' as const;
export const OUTBOX_DEDUPE_INDEX = 'outbox_dedupe_unique_v1' as const;
export const OUTBOX_RETENTION_INDEX = 'outbox_retention_ttl_v1' as const;
export const OUTBOX_BACKLOG_INDEX = 'outbox_backlog_v1' as const;
export const OUTBOX_HANDLER_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,95}$/;
