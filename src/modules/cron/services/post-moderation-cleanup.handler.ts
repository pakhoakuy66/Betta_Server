import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  OutboxPermanentError,
  OutboxRetryLaterError,
} from '../../../common/outbox/outbox.errors';
import { OutboxHandlerRegistry } from '../../../common/outbox/outbox-handler.registry';
import type {
  ClaimedOutboxEvent,
  OutboxEventHandler,
} from '../../../common/outbox/outbox.interface';
import { ADMIN_POST_MODERATION_EVENT_TYPE } from '../../admin/constants/admin-post-moderation.constants';
import { PostModerationState } from '../../posts/schemas/post.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import { ExpiredPostCleanupService } from './expired-post-cleanup.service';

@Injectable()
export class PostModerationCleanupHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_POST_MODERATION_EVENT_TYPE;
  readonly handlerId = 'moderation.post.cleanup.v1';
  readonly order = 200;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly cleanup: ExpiredPostCleanupService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload;
    if (
      event.schemaVersion !== 1 ||
      event.aggregateType !== 'post' ||
      !isValidPostPublicId(event.aggregatePublicId) ||
      payload.schemaVersion !== 1 ||
      payload.postPublicId !== event.aggregatePublicId
    ) {
      throw new OutboxPermanentError(
        'INVALID_POST_CLEANUP_EVENT',
        'Post cleanup event không hợp lệ',
      );
    }
    if (
      payload.cleanupRequested !== true ||
      payload.state !== PostModerationState.TERMINAL_DELETED
    ) {
      return;
    }

    const result = await this.cleanup.cleanupRequestedPost(
      event.aggregatePublicId,
    );
    if (result === 'REQUIRES_INTERVENTION') {
      throw new OutboxPermanentError(
        'POST_CLEANUP_MANUAL_REVIEW',
        'Post cleanup cần kiểm tra thủ công',
      );
    }
    if (typeof result === 'object' && result.status === 'RETRY_LATER') {
      throw new OutboxRetryLaterError(
        'POST_CLEANUP_IN_PROGRESS',
        'Post cleanup đang chờ reconciliation',
        result.retryAt,
      );
    }
  }
}
