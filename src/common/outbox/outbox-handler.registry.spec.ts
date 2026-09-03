import { describe, expect, it } from '@jest/globals';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

describe('OutboxHandlerRegistry', () => {
  it('supports deterministic multi-handler ordering', () => {
    const registry = new OutboxHandlerRegistry();
    registry.register({
      eventType: 'moderation.test.changed',
      handlerId: 'moderation.test.second.v1',
      order: 200,
      handle: () => Promise.resolve(),
    });
    registry.register({
      eventType: 'moderation.test.changed',
      handlerId: 'moderation.test.first.v1',
      order: 100,
      handle: () => Promise.resolve(),
    });
    registry.register({
      eventType: 'moderation.test.changed',
      handlerId: 'moderation.test.a.v1',
      order: 150,
      handle: () => Promise.resolve(),
    });
    registry.register({
      eventType: 'moderation.test.changed',
      handlerId: 'moderation.test-a.v1',
      order: 150,
      handle: () => Promise.resolve(),
    });

    expect(
      registry
        .resolve('moderation.test.changed')
        .map((handler) => handler.handlerId),
    ).toStrictEqual([
      'moderation.test.first.v1',
      'moderation.test-a.v1',
      'moderation.test.a.v1',
      'moderation.test.second.v1',
    ]);
  });

  it('rejects duplicate handler identity without blocking sibling handlers', () => {
    const registry = new OutboxHandlerRegistry();
    const handler = {
      eventType: 'moderation.test.changed',
      handlerId: 'moderation.test.same.v1',
      handle: () => Promise.resolve(),
    };
    registry.register(handler);

    expect(() => registry.register(handler)).toThrow('đã tồn tại');
  });
});
