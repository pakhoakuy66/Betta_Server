import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';
import { normalizeSponsoredMedia } from './sponsored-media.policy';
const image = (width = 64, height = 64) =>
  sharp({ create: { width, height, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
describe('Sponsored image decoding', () => {
  it('decodes and converts valid PNG into static WebP', async () => {
    const buffer = await image();
    const output = await normalizeSponsoredMedia({
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
    });
    expect((await sharp(output).metadata()).format).toBe('webp');
  });
  it('rejects spoofed MIME', async () => {
    const buffer = await image();
    await expect(
      normalizeSponsoredMedia({
        buffer,
        size: buffer.length,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow('SPONSORED_MEDIA_INVALID');
  });
  it.each([
    Buffer.from('<svg onload="alert(1)"/>'),
    Buffer.from('not an image'),
  ])('rejects undecodable content', async (buffer) => {
    await expect(
      normalizeSponsoredMedia({
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
      }),
    ).rejects.toThrow();
  });
  it.each([
    [63, 64],
    [4097, 64],
  ])('rejects dimensions %i x %i', async (width, height) => {
    const buffer = await image(width, height);
    await expect(
      normalizeSponsoredMedia({
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
      }),
    ).rejects.toThrow();
  });
  it('rejects oversized and mismatched buffers before decoding', async () => {
    const buffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    await expect(
      normalizeSponsoredMedia({
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
      }),
    ).rejects.toThrow();
    await expect(
      normalizeSponsoredMedia({
        buffer: await image(),
        size: 1,
        mimetype: 'image/png',
      }),
    ).rejects.toThrow();
  });
  it('rejects truncated images', async () => {
    const full = await image();
    const buffer = full.subarray(0, full.length / 2);
    await expect(
      normalizeSponsoredMedia({
        buffer,
        size: buffer.length,
        mimetype: 'image/png',
      }),
    ).rejects.toThrow();
  });
});
