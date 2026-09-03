import { Injectable } from '@nestjs/common';
import {
  OUTBOX_EVENT_TYPE_PATTERN,
  OUTBOX_HANDLER_ID_PATTERN,
} from './outbox.constants';
import type { OutboxEventHandler } from './outbox.interface';

const compareHandlerIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<
    string,
    Map<string, OutboxEventHandler>
  >();

  register(handler: OutboxEventHandler): void {
    if (
      !OUTBOX_EVENT_TYPE_PATTERN.test(handler.eventType) ||
      !OUTBOX_HANDLER_ID_PATTERN.test(handler.handlerId) ||
      (handler.order !== undefined && !Number.isSafeInteger(handler.order))
    ) {
      throw new TypeError('Outbox handler không hợp lệ');
    }
    const eventHandlers =
      this.handlers.get(handler.eventType) ??
      new Map<string, OutboxEventHandler>();
    if (eventHandlers.has(handler.handlerId)) {
      throw new Error(`Outbox handler đã tồn tại: ${handler.handlerId}`);
    }
    eventHandlers.set(handler.handlerId, handler);
    this.handlers.set(handler.eventType, eventHandlers);
  }

  resolve(eventType: string): readonly OutboxEventHandler[] {
    return Object.freeze(
      [...(this.handlers.get(eventType)?.values() ?? [])].sort(
        (left, right) =>
          (left.order ?? 100) - (right.order ?? 100) ||
          compareHandlerIds(left.handlerId, right.handlerId),
      ),
    );
  }
}
