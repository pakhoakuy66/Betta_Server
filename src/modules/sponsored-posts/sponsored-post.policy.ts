import { BadRequestException, ConflictException } from '@nestjs/common';
import { isIP } from 'node:net';
import {
  SPONSORED_DAY_MS,
  SponsoredAssetHealth,
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from './sponsored-post.constants';

export type SponsoredImage = Readonly<{ url: string; publicId: string }>;
export type SponsoredDraftInput = Readonly<{
  content: string;
  images: readonly SponsoredImage[];
  destinationUrl: string;
  cta: string;
  startAt: Date;
  endAt: Date;
}>;
export type SponsoredLifecycleState = SponsoredDraftInput &
  Readonly<{
    status: Status;
    assetHealth: SponsoredAssetHealth;
    deletedAt: Date | null;
  }>;

const badInput = (): never => {
  throw new BadRequestException('SPONSORED_INPUT_INVALID');
};

export function assertSponsoredSchedule(startAt: Date, endAt: Date): void {
  const start = startAt instanceof Date ? startAt.getTime() : NaN;
  const end = endAt instanceof Date ? endAt.getTime() : NaN;
  const duration = end - start;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    duration < SPONSORED_DAY_MS ||
    duration > 365 * SPONSORED_DAY_MS
  )
    badInput();
}

/** Pure validation only: no DNS lookup, outbound request or redirect following. */
export function canonicalSponsoredUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    badInput();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return badInput();
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port !== '' && url.port !== '443') ||
    isIP(host.replace(/^\[|\]$/g, '')) !== 0 ||
    host.endsWith('.') ||
    !host.includes('.') ||
    host.length > 253 ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|onion|home|lan)$/i.test(
      host,
    ) ||
    !host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
    badInput();
  return url.href;
}

export function normalizeSponsoredDraft(
  input: SponsoredDraftInput,
): SponsoredDraftInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) badInput();
  const allowed = new Set([
    'content',
    'images',
    'destinationUrl',
    'cta',
    'startAt',
    'endAt',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) badInput();
  assertSponsoredSchedule(input.startAt, input.endAt);
  if (
    typeof input.content !== 'string' ||
    input.content.trim().length > 2500 ||
    typeof input.cta !== 'string' ||
    !input.cta.trim() ||
    input.cta.trim().length > 80 ||
    !Array.isArray(input.images) ||
    input.images.length > 3
  )
    badInput();
  const images = input.images.map((image) => {
    if (
      !image ||
      typeof image !== 'object' ||
      Object.keys(image).some((key) => key !== 'url' && key !== 'publicId') ||
      typeof image.publicId !== 'string' ||
      image.publicId.length > 255 ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(image.publicId)
    )
      badInput();
    const url = canonicalSponsoredUrl(image.url);
    const parsed = new URL(url);
    if (
      parsed.hostname !== 'res.cloudinary.com' ||
      parsed.search ||
      !/^\/[^/]+\/image\/upload\//.test(parsed.pathname)
    )
      badInput();
    return { url, publicId: image.publicId };
  });
  if (
    (!input.content.trim() && !images.length) ||
    new Set(images.map((image) => image.publicId)).size !== images.length
  )
    badInput();
  return {
    content: input.content.trim(),
    images,
    destinationUrl: canonicalSponsoredUrl(input.destinationUrl),
    cta: input.cta.trim(),
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
  };
}

const transitions: Readonly<Record<Action, readonly Status[]>> = Object.freeze({
  [Action.SCHEDULE]: [Status.DRAFT],
  [Action.RETURN_TO_DRAFT]: [Status.SCHEDULED, Status.PAUSED],
  [Action.ACTIVATE]: [Status.SCHEDULED],
  [Action.PAUSE]: [Status.SCHEDULED, Status.ACTIVE],
  [Action.RESUME]: [Status.PAUSED],
  [Action.EXPIRE]: [Status.ACTIVE, Status.PAUSED],
  [Action.DELETE]: [
    Status.DRAFT,
    Status.SCHEDULED,
    Status.ACTIVE,
    Status.PAUSED,
    Status.EXPIRED,
  ],
  [Action.RESTORE]: [Status.DELETED],
});
const targets: Readonly<Record<Action, Status>> = Object.freeze({
  [Action.SCHEDULE]: Status.SCHEDULED,
  [Action.RETURN_TO_DRAFT]: Status.DRAFT,
  [Action.ACTIVATE]: Status.ACTIVE,
  [Action.PAUSE]: Status.PAUSED,
  [Action.RESUME]: Status.ACTIVE,
  [Action.EXPIRE]: Status.EXPIRED,
  [Action.DELETE]: Status.DELETED,
  [Action.RESTORE]: Status.DRAFT,
});

export function nextSponsoredStatus(
  record: SponsoredLifecycleState,
  action: Action,
  now: Date,
): Status {
  const clock = now instanceof Date ? now.getTime() : NaN;
  if (
    !Number.isFinite(clock) ||
    !transitions[action]?.includes(record.status)
  ) {
    throw new ConflictException('SPONSORED_TRANSITION_NOT_ALLOWED');
  }
  assertSponsoredSchedule(record.startAt, record.endAt);
  if ((record.status === Status.DELETED) !== (record.deletedAt !== null)) {
    throw new ConflictException('SPONSORED_STATE_INCONSISTENT');
  }
  const end = record.endAt.getTime();
  if (
    (action === Action.SCHEDULE || action === Action.RESTORE) &&
    clock >= end
  ) {
    throw new ConflictException('SPONSORED_SCHEDULE_ENDED');
  }
  if (action === Action.EXPIRE && clock < end) {
    throw new ConflictException('SPONSORED_NOT_ENDED');
  }
  if (action === Action.ACTIVATE || action === Action.RESUME) {
    normalizeSponsoredDraft({
      content: record.content,
      images: record.images.map(({ url, publicId }) => ({ url, publicId })),
      cta: record.cta,
      destinationUrl: record.destinationUrl,
      startAt: record.startAt,
      endAt: record.endAt,
    });
    if (
      clock < record.startAt.getTime() ||
      clock >= end ||
      record.assetHealth !== SponsoredAssetHealth.HEALTHY
    ) {
      throw new ConflictException('SPONSORED_NOT_ELIGIBLE');
    }
  }
  return targets[action];
}
