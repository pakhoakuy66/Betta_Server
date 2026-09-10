import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export const SPONSORED_MEDIA_LIMITS = Object.freeze({
  count: 3,
  bytes: 5 * 1024 * 1024,
  pixels: 16_000_000,
  minDimension: 64,
  maxDimension: 4096,
});
export type SponsoredUpload = Readonly<{
  buffer: Buffer;
  mimetype: string;
  size: number;
}>;
export async function normalizeSponsoredMedia(
  file: SponsoredUpload,
): Promise<Buffer> {
  const limits = SPONSORED_MEDIA_LIMITS;
  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    file.size !== file.buffer.length ||
    file.size < 1 ||
    file.size > limits.bytes ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
  )
    throw new BadRequestException('SPONSORED_MEDIA_INVALID');
  try {
    const options = {
      limitInputPixels: limits.pixels,
      failOn: 'warning' as const,
    };
    const metadata = await sharp(file.buffer, options).metadata();
    const mime: Record<string, string> = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    if (
      !metadata.format ||
      mime[metadata.format] !== file.mimetype ||
      (metadata.pages ?? 1) !== 1 ||
      !metadata.width ||
      !metadata.height ||
      Math.min(metadata.width, metadata.height) < limits.minDimension ||
      Math.max(metadata.width, metadata.height) > limits.maxDimension
    )
      throw new Error('Invalid image');
    const output = await sharp(file.buffer, options)
      .rotate()
      .webp({ quality: 85 })
      .toBuffer();
    if (output.length > limits.bytes)
      throw new Error('Encoded image too large');
    return output;
  } catch {
    throw new BadRequestException('SPONSORED_MEDIA_INVALID');
  }
}
