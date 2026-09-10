import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { SponsoredMediaCloudService } from './sponsored-media-cloud.service';
const service = new SponsoredMediaCloudService(
  new ConfigService({
    SPONSORED_MEDIA_ENV: 'test',
    CLOUDINARY_CLOUD_NAME: 'fixture',
    CLOUDINARY_API_KEY: 'synthetic',
    CLOUDINARY_API_SECRET: 'synthetic',
  }),
);
const id = `sma_${'a'.repeat(32)}`;
describe('Sponsored Cloudinary boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('uses server-owned environment namespace', () => {
    expect(service.remoteId(id)).toBe(`betta/test/sponsored/${id}`);
  });
  it('rejects deleting arbitrary or cross-environment IDs before external IO', async () => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy');
    await expect(
      service.destroy(`betta/production/sponsored/${id}`),
    ).rejects.toThrow('SPONSORED_ASSET_SCOPE_INVALID');
    await expect(service.destroy('avatars/other')).rejects.toThrow();
    expect(destroy).not.toHaveBeenCalled();
  });
  it('accepts not-found cleanup as idempotent success', async () => {
    jest
      .spyOn(cloudinary.uploader, 'destroy')
      .mockResolvedValue({ result: 'not found' } as never);
    await expect(
      service.destroy(service.remoteId(id)),
    ).resolves.toBeUndefined();
  });
  it('only treats a 404 as missing', async () => {
    jest
      .spyOn(cloudinary.api, 'resource')
      .mockRejectedValue({ error: { http_code: 404 } } as never);
    await expect(service.health(service.remoteId(id))).resolves.toBe('missing');
  });
  it.each([401, 429, 500])(
    'propagates infrastructure status %i',
    async (status) => {
      jest
        .spyOn(cloudinary.api, 'resource')
        .mockRejectedValue({ error: { http_code: status } } as never);
      await expect(service.health(service.remoteId(id))).rejects.toThrow(
        'SPONSORED_HEALTH_UNAVAILABLE',
      );
    },
  );
});
