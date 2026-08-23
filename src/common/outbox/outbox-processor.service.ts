import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_LEASE_MS,
} from './outbox.constants';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import type { ClaimedOutboxEvent } from './outbox.interface';
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
      for (let index = 0; index < batchSize; index += 1) {
        const claimed = await this.outbox.claim(
          new Date(),
          OUTBOX_DEFAULT_LEASE_MS,
        );
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
    const handler = this.handlers.resolve(event.eventType);
    if (!handler) {
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
    try {
      await handler.handle(event);
      await this.outbox.markPublished(event.publicId, leaseId, new Date());
    } catch (error: unknown) {
      const code = this.safeErrorCode(error);
      await this.outbox.markFailed(event, leaseId, code, new Date());
      this.logger.error(
        `Outbox handler failed eventType=${event.eventType} publicId=${event.publicId} attempt=${event.attempt} errorCode=${code}`,
      );
    }
  }

  private safeErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code))
        return code;
    }
    return 'HANDLER_FAILED';
  }
}
