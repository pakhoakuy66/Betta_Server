import { describe, expect, it, jest } from '@jest/globals';
import type { Model } from 'mongoose';
import type { AccessSupportDedupe } from '../schemas/access-support-dedupe.schema';
import { AccessSupportDedupeService } from './access-support-dedupe.service';

describe('AccessSupportDedupeService', () => {
  it('returns the active claim after a concurrent unique-key race', async () => {
    const create = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue({ code: 11000 });
    const exec = jest
      .fn<
        () => Promise<{
          reportPublicId: string;
          activeUntil: Date;
        }>
      >()
      .mockResolvedValue({
        reportPublicId: 'srep_existing234567',
        activeUntil: new Date('2026-08-21T10:15:00.000Z'),
      });
    const findOne = jest.fn(() => ({
      select: jest.fn(() => ({ lean: jest.fn(() => ({ exec })) })),
    }));
    const model = { create, findOne } as unknown as Model<AccessSupportDedupe>;
    const service = new AccessSupportDedupeService(model);

    await expect(
      service.claim('fingerprint', new Date('2026-08-21T10:00:00.001Z')),
    ).resolves.toEqual({ reportPublicId: 'srep_existing234567' });
  });
});
