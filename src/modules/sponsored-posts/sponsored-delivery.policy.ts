import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

export const DELIVERY = Object.freeze({
  sessionMs: 60 * 60_000,
  cooldownMs: 24 * 60 * 60_000,
  maxPageSize: 100,
  maxCandidates: 100,
});
export function issueFeedSessionId(): string {
  return `fss_${randomBytes(32).toString('base64url')}`;
}
export function sessionDigest(value: string): string {
  if (typeof value !== 'string' || !/^fss_[A-Za-z0-9_-]{43}$/.test(value))
    throw new BadRequestException('SPONSORED_FEED_SESSION_INVALID');
  return createHash('sha256').update(value).digest('hex');
}
export function validPage(page: number, limit: number): void {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DELIVERY.maxPageSize
  )
    throw new BadRequestException('SPONSORED_DELIVERY_PAGE_INVALID');
}
export function uniqueIds(
  values: readonly string[],
  pattern: RegExp,
  maximum: number,
): void {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    values.some((value) => typeof value !== 'string' || !pattern.test(value)) ||
    new Set(values).size !== values.length
  )
    throw new BadRequestException('SPONSORED_DELIVERY_IDS_INVALID');
}
