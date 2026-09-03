import type { ClientSession } from 'mongoose';
import type { OutboxStatus } from './outbox.constants';

export type OutboxPayload = Readonly<Record<string, unknown>>;

export type EnqueueOutboxEventInput = Readonly<{
  eventType: string;
  dedupeKey: string;
  aggregateType: string;
  aggregatePublicId: string;
  payload: OutboxPayload;
  correlationId?: string;
  availableAt?: Date;
  mongoSession: ClientSession;
}>;

export type ClaimedOutboxEvent = Readonly<{
  publicId: string;
  schemaVersion: number;
  eventType: string;
  dedupeKey: string;
  aggregateType: string;
  aggregatePublicId: string;
  payload: OutboxPayload;
  correlationId?: string;
  attempt: number;
  occurredAt: Date;
  completedHandlerIds?: readonly string[];
}>;

export interface OutboxEventHandler {
  readonly eventType: string;
  readonly handlerId: string;
  readonly order?: number;
  handle(event: ClaimedOutboxEvent): Promise<void>;
}

export type OutboxBacklogMetrics = Readonly<{
  pending: number;
  processing: number;
  deadLetter: number;
  oldestPendingAt: string | null;
}>;

export type StoredOutboxState = Readonly<{
  status: OutboxStatus;
  attempt: number;
}>;

export type OutboxFailure = Readonly<{
  code: string;
  retryable: boolean;
  retryAt?: Date;
}>;
