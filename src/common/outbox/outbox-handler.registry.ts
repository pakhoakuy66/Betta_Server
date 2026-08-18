import { Injectable } from '@nestjs/common';
import { OUTBOX_EVENT_TYPE_PATTERN } from './outbox.constants';
import type { OutboxEventHandler } from './outbox.interface';

@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<string, OutboxEventHandler>();

  register(handler: OutboxEventHandler): void {
    if (!OUTBOX_EVENT_TYPE_PATTERN.test(handler.eventType)) {
      throw new TypeError('Outbox event type không hợp lệ');
    }
    if (this.handlers.has(handler.eventType)) {
      throw new Error(`Outbox handler đã tồn tại: ${handler.eventType}`);
    }
    this.handlers.set(handler.eventType, handler);
  }

  resolve(eventType: string): OutboxEventHandler | undefined {
    return this.handlers.get(eventType);
  }
}
