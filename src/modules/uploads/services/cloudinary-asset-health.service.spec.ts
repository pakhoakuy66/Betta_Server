import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { v2 as cloudinary } from 'cloudinary';
import type { Mock } from 'jest-mock';
import { CloudinaryAssetHealthService } from './cloudinary-asset-health.service';

jest.mock('cloudinary', () => ({
  v2: {
    api: { resources_by_ids: jest.fn() },
  },
}));

const resourcesByIds = cloudinary.api.resources_by_ids as unknown as Mock<
  (...args: unknown[]) => Promise<unknown>
>;

describe('CloudinaryAssetHealthService', () => {
  const service = new CloudinaryAssetHealthService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns only unavailable IDs and deduplicates input', async () => {
    resourcesByIds.mockResolvedValue({
      resources: [{ public_id: 'betta/posts/present' }],
    });

    await expect(
      service.findMissingImagePublicIds([
        'betta/posts/present',
        'betta/posts/missing',
        'betta/posts/present',
        '',
      ]),
    ).resolves.toEqual(['betta/posts/missing']);
    expect(resourcesByIds).toHaveBeenCalledTimes(1);
  });

  it('does not call Cloudinary for an empty list', async () => {
    await expect(service.findMissingImagePublicIds([])).resolves.toEqual([]);
    expect(resourcesByIds).not.toHaveBeenCalled();
  });

  it('propagates infrastructure failures instead of reporting false missing', async () => {
    const failure = new Error('Cloudinary Admin API unavailable');
    resourcesByIds.mockRejectedValue(failure);

    await expect(
      service.findMissingImagePublicIds(['betta/posts/a']),
    ).rejects.toBe(failure);
  });

  it('queries at most 100 IDs per Cloudinary request', async () => {
    resourcesByIds.mockResolvedValue({ resources: [] });
    const ids = Array.from({ length: 201 }, (_, index) => `asset-${index}`);

    await expect(service.findMissingImagePublicIds(ids)).resolves.toHaveLength(
      201,
    );
    expect(resourcesByIds).toHaveBeenCalledTimes(3);
  });
});
