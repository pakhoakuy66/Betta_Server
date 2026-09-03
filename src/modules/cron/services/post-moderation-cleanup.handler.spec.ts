import { describe, expect, it, jest } from '@jest/globals';
import type { ClaimedOutboxEvent } from '../../../common/outbox/outbox.interface';
import { PostModerationState } from '../../posts/schemas/post.schema';
import { PostModerationCleanupHandler } from './post-moderation-cleanup.handler';

const event = (
  overrides: Partial<ClaimedOutboxEvent> = {},
): ClaimedOutboxEvent => ({
  publicId: 'obx_23456789ABCDEFGHJKLMNP',
  schemaVersion: 1,
  eventType: 'moderation.post.state_changed',
  dedupeKey: 'post-moderation:post_23456789ABCD:1',
  aggregateType: 'post',
  aggregatePublicId: 'post_23456789ABCD',
  payload: {
    schemaVersion: 1,
    postPublicId: 'post_23456789ABCD',
    state: PostModerationState.TERMINAL_DELETED,
    moderationVersion: 1,
    cleanupRequested: true,
  },
  attempt: 1,
  occurredAt: new Date('2026-09-01T00:00:00.000Z'),
  completedHandlerIds: [],
  ...overrides,
});

describe('PostModerationCleanupHandler', () => {
  it('dispatches terminal cleanup through the fenced cleanup service', async () => {
    const cleanup = {
      cleanupRequestedPost: jest.fn<(publicId: string) => Promise<string>>(() =>
        Promise.resolve('COMPLETED'),
      ),
    };
    const handler = new PostModerationCleanupHandler(
      { register: jest.fn() } as never,
      cleanup as never,
    );

    await handler.handle(event());

    expect(cleanup.cleanupRequestedPost).toHaveBeenCalledWith(
      'post_23456789ABCD',
    );
  });

  it('does not dispatch cleanup for hide or restore events', async () => {
    const cleanup = { cleanupRequestedPost: jest.fn() };
    const handler = new PostModerationCleanupHandler(
      { register: jest.fn() } as never,
      cleanup as never,
    );

    await handler.handle(
      event({
        payload: {
          schemaVersion: 1,
          postPublicId: 'post_23456789ABCD',
          state: PostModerationState.HIDDEN,
          moderationVersion: 1,
          cleanupRequested: false,
        },
      }),
    );

    expect(cleanup.cleanupRequestedPost).not.toHaveBeenCalled();
  });

  it('marks ambiguous destructive cleanup as permanent intervention', async () => {
    const cleanup = {
      cleanupRequestedPost: jest.fn(() =>
        Promise.resolve('REQUIRES_INTERVENTION'),
      ),
    };
    const handler = new PostModerationCleanupHandler(
      { register: jest.fn() } as never,
      cleanup as never,
    );

    await expect(handler.handle(event())).rejects.toMatchObject({
      code: 'POST_CLEANUP_MANUAL_REVIEW',
      retryable: false,
    });
  });

  it('reschedules cleanup that is still owned without publishing it', async () => {
    const retryAt = new Date('2026-09-01T00:05:00.000Z');
    const cleanup = {
      cleanupRequestedPost: jest.fn(() =>
        Promise.resolve({ status: 'RETRY_LATER', retryAt }),
      ),
    };
    const handler = new PostModerationCleanupHandler(
      { register: jest.fn() } as never,
      cleanup as never,
    );

    await expect(handler.handle(event())).rejects.toMatchObject({
      code: 'POST_CLEANUP_IN_PROGRESS',
      retryable: true,
      retryAt,
    });
  });
});
