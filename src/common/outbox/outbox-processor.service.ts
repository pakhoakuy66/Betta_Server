import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_LEASE_MS,
  OUTBOX_MAX_LEASE_MS,
  OUTBOX_MIN_LEASE_MS,
  OUTBOX_RECONCILIATION_BATCH_SIZE,
} from './outbox.constants';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import type {
  ClaimedOutboxEvent,
  OutboxEventHandler,
  OutboxFailure,
} from './outbox.interface';
import { OutboxService } from './outbox.service';

@Injectable()
export class OutboxProcessorService {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly handlers: OutboxHandlerRegistry,
    private readonly config: ConfigService,
  ) {}

  @Interval(5_000)
  async scheduledDrain(): Promise<void> {
    if (this.config.get<string>('OUTBOX_PROCESSOR_ENABLED') !== 'true') return;
    await this.drain();
  }

  async drain(batchSize = OUTBOX_DEFAULT_BATCH_SIZE): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      await this.outbox.reconcileExpiredLeases(
        new Date(),
        OUTBOX_RECONCILIATION_BATCH_SIZE,
      );
      for (let index = 0; index < batchSize; index += 1) {
        const claimed = await this.outbox.claim(new Date(), this.leaseMs());
        if (!claimed) break;
        await this.process(claimed.event, claimed.leaseId);
        processed += 1;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async process(
    event: ClaimedOutboxEvent,
    leaseId: string,
  ): Promise<void> {
    const handlers = this.handlers.resolve(event.eventType);
    if (handlers.length === 0) {
      await this.outbox.markFailed(
        event,
        leaseId,
        'HANDLER_NOT_REGISTERED',
        new Date(),
      );
      this.logger.error(
        `Outbox handler missing eventType=${event.eventType} publicId=${event.publicId}`,
      );
      return;
    }

    const completed = new Set(event.completedHandlerIds ?? []);
    for (const handler of handlers) {
      if (completed.has(handler.handlerId)) continue;
      const owned = await this.runHandler(event, leaseId, handler);
      if (!owned) return;
    }
    await this.outbox.markPublished(event.publicId, leaseId, new Date());
  }

  private async runHandler(
    event: ClaimedOutboxEvent,
    leaseId: string,
    handler: OutboxEventHandler,
  ): Promise<boolean> {
    const leaseMs = this.leaseMs();
    let leaseLost = false;
    let heartbeatPromise: Promise<void> | null = null;
    const heartbeat = setInterval(
      () => {
        if (heartbeatPromise) return;
        heartbeatPromise = this.outbox
          .extendLease(event.publicId, leaseId, new Date(), leaseMs)
          .then((owned) => {
            if (!owned) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            heartbeatPromise = null;
          });
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();

    try {
      await handler.handle(event);
      await Promise.resolve(heartbeatPromise);
      if (leaseLost) {
        this.logger.warn(
          `Outbox lease lost after handler eventType=${event.eventType} handlerId=${handler.handlerId} publicId=${event.publicId}`,
        );
        return false;
      }
      return this.outbox.completeHandler(
        event.publicId,
        leaseId,
        handler.handlerId,
      );
    } catch (error: unknown) {
      await Promise.resolve(heartbeatPromise);
      if (leaseLost) return false;
      const failure = this.safeFailure(error);
      const failedAt = new Date();
      if (failure.retryAt && failure.retryable) {
        await this.outbox.reschedule(
          event,
          leaseId,
          failure.code,
          failedAt,
          failure.retryAt,
        );
      } else {
        await this.outbox.markFailed(
          event,
          leaseId,
          failure.code,
          failedAt,
          failure.retryable,
        );
      }
      this.logger.error(
        `Outbox handler failed eventType=${event.eventType} handlerId=${handler.handlerId} publicId=${event.publicId} attempt=${event.attempt} errorCode=${failure.code}`,
      );
      return false;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private safeFailure(error: unknown): OutboxFailure {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      const retryable = (error as { retryable?: unknown }).retryable;
      const retryAt = (error as { retryAt?: unknown }).retryAt;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
        return Object.freeze({
          code,
          retryable: retryable !== false,
          ...(retryable !== false &&
          retryAt instanceof Date &&
          !Number.isNaN(retryAt.getTime())
            ? { retryAt }
            : {}),
        });
      }
    }
    return Object.freeze({ code: 'HANDLER_FAILED', retryable: true });
  }

  private leaseMs(): number {
    const configured = Number(this.config.get<string>('OUTBOX_LEASE_MS'));
    if (
      Number.isSafeInteger(configured) &&
      configured >= OUTBOX_MIN_LEASE_MS &&
      configured <= OUTBOX_MAX_LEASE_MS
    ) {
      return configured;
    }
    return OUTBOX_DEFAULT_LEASE_MS;
  }
}
