import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxHandlerRegistry } from '../../common/outbox/outbox-handler.registry';
import { OutboxPermanentError } from '../../common/outbox/outbox.errors';
import type {
  ClaimedOutboxEvent,
  OutboxEventHandler,
} from '../../common/outbox/outbox.interface';
import { SPONSORED_PUBLIC_ID_PATTERN } from './sponsored-post.constants';
import { SponsoredMediaService } from './sponsored-media.service';
@Injectable()
export class SponsoredMediaCleanupHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = 'sponsored.media.cleanup';
  readonly handlerId = 'sponsored.media.cleanup.v1';
  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly media: SponsoredMediaService,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const id = event.payload.assetId;
    if (
      event.schemaVersion !== 1 ||
      event.aggregateType !== 'sponsored_post' ||
      !SPONSORED_PUBLIC_ID_PATTERN.test(event.aggregatePublicId) ||
      Object.keys(event.payload).some((key) => key !== 'assetId') ||
      (id !== undefined &&
        (typeof id !== 'string' || !/^sma_[a-f0-9]{32}$/.test(id)))
    )
      throw new OutboxPermanentError(
        'SPONSORED_CLEANUP_EVENT_INVALID',
        'Invalid event',
      );
    await this.media.cleanup(event.aggregatePublicId, id);
  }
}
