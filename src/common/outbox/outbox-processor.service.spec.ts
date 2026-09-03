import { describe, expect, it, jest } from '@jest/globals';
import { OutboxProcessorService } from './outbox-processor.service';

describe('OutboxProcessorService scheduling gate', () => {
  it.each([undefined, 'false', 'TRUE', '1'])(
    'does not drain unless explicitly enabled (value=%s)',
    async (value) => {
      const outbox = {
        claim: jest.fn(),
        reconcileExpiredLeases: jest.fn(),
      };
      const service = new OutboxProcessorService(
        outbox as never,
        {} as never,
        { get: jest.fn(() => value) } as never,
      );

      await service.scheduledDrain();

      expect(outbox.claim).not.toHaveBeenCalled();
    },
  );

  it('drains when explicitly enabled', async () => {
    const outbox = {
      claim: jest.fn(() => Promise.resolve(null)),
      reconcileExpiredLeases: jest.fn(() => Promise.resolve(0)),
    };
    const service = new OutboxProcessorService(
      outbox as never,
      {} as never,
      { get: jest.fn(() => 'true') } as never,
    );

    await service.scheduledDrain();

    expect(outbox.claim).toHaveBeenCalledTimes(1);
  });
});
