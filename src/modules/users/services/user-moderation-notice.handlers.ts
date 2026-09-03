import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxHandlerRegistry } from '../../../common/outbox/outbox-handler.registry';
import type {
  ClaimedOutboxEvent,
  OutboxEventHandler,
} from '../../../common/outbox/outbox.interface';
import { ADMIN_USER_DELETION_EVENT_TYPE } from '../../admin/constants/admin-user-deletion.constants';
import { ADMIN_USER_RESTRICTION_EVENT_TYPE } from '../../admin/constants/admin-user-restriction.constants';
import { ADMIN_POST_MODERATION_EVENT_TYPE } from '../../admin/constants/admin-post-moderation.constants';
import { UserModerationNoticeService } from './user-moderation-notice.service';

@Injectable()
export class UserRestrictionChangedHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_USER_RESTRICTION_EVENT_TYPE;
  readonly handlerId = 'moderation.user-restriction.notice.v1';
  readonly order = 100;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly notices: UserModerationNoticeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: ClaimedOutboxEvent): Promise<void> {
    return this.notices.consumeRestrictionEvent(event);
  }
}

@Injectable()
export class UserDeletionChangedHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_USER_DELETION_EVENT_TYPE;
  readonly handlerId = 'moderation.user-deletion.notice.v1';
  readonly order = 100;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly notices: UserModerationNoticeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: ClaimedOutboxEvent): Promise<void> {
    return this.notices.consumeDeletionEvent(event);
  }
}

@Injectable()
export class PostModerationChangedHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_POST_MODERATION_EVENT_TYPE;
  readonly handlerId = 'moderation.post.notice.v1';
  readonly order = 100;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly notices: UserModerationNoticeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: ClaimedOutboxEvent): Promise<void> {
    return this.notices.consumePostEvent(event);
  }
}

@Injectable()
export class UserRestrictionSessionRevocationHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_USER_RESTRICTION_EVENT_TYPE;
  readonly handlerId = 'moderation.user-restriction.session-revoke.v1';
  readonly order = 50;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly notices: UserModerationNoticeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: ClaimedOutboxEvent): Promise<void> {
    return this.notices.reconcileSessionRevocation(event);
  }
}

@Injectable()
export class UserDeletionSessionRevocationHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_USER_DELETION_EVENT_TYPE;
  readonly handlerId = 'moderation.user-deletion.session-revoke.v1';
  readonly order = 50;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly notices: UserModerationNoticeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: ClaimedOutboxEvent): Promise<void> {
    return this.notices.reconcileSessionRevocation(event);
  }
}
