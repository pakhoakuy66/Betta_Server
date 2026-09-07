import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  SPONSORED_DAY_MS as DAY,
  SponsoredAssetHealth as Health,
  SponsoredPostStatus as Status,
  SponsoredTransition as Action,
} from './sponsored-post.constants';
import {
  assertSponsoredSchedule,
  canonicalSponsoredUrl,
  nextSponsoredStatus,
  normalizeSponsoredDraft,
} from './sponsored-post.policy';

const now = new Date('2035-06-01T00:00:00Z');
const draft = () => ({
  content: 'Sponsored fixture',
  images: [],
  destinationUrl: 'https://example.com/offer',
  cta: 'Learn more',
  startAt: new Date(now),
  endAt: new Date(now.getTime() + 2 * DAY),
});
const state = (status: Status) => ({
  ...draft(),
  status,
  assetHealth: Health.HEALTHY,
  deletedAt: status === Status.DELETED ? new Date(now) : null,
});

describe('SADM-SPON-01 policy', () => {
  it.each([1, 365])('accepts %i days at exact boundaries', (days) => {
    expect(() =>
      assertSponsoredSchedule(now, new Date(now.getTime() + days * DAY)),
    ).not.toThrow();
  });
  it.each([0, DAY - 1, 365 * DAY + 1, -DAY, NaN])(
    'rejects invalid duration %s',
    (duration) => {
      expect(() =>
        assertSponsoredSchedule(now, new Date(now.getTime() + duration)),
      ).toThrow(BadRequestException);
    },
  );
  it('compares actual UTC instants, not local calendar dates', () => {
    expect(() =>
      assertSponsoredSchedule(
        new Date('2035-06-01T07:00:00+07:00'),
        new Date('2035-06-02T00:00:00Z'),
      ),
    ).not.toThrow();
  });
  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'https://localhost',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://10.1.1.1',
    'https://name:password@example.com',
    'https://example.com:8443',
    'https://example.com/#token',
    'https://internal.local',
    'https://example.com\\evil',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => canonicalSponsoredUrl(url)).toThrow(BadRequestException);
  });
  it('canonicalizes HTTPS without making external calls', () => {
    expect(canonicalSponsoredUrl('https://EXAMPLE.com:443/offer')).toBe(
      'https://example.com/offer',
    );
  });
  it('rejects mass assignment and organic-only fields', () => {
    for (const extra of [
      { status: Status.ACTIVE },
      { assetHealth: Health.HEALTHY },
      { ownerPublicId: 'adm_23456789ABCD' },
      { expireAt: now },
      { streakCount: 1 },
    ]) {
      expect(() => normalizeSponsoredDraft({ ...draft(), ...extra })).toThrow(
        BadRequestException,
      );
    }
  });
  it('bounds creative data and rejects duplicate media', () => {
    const image = {
      url: 'https://res.cloudinary.com/demo/image/upload/v1/banner.jpg',
      publicId: 'sponsored/banner',
    };
    expect(
      normalizeSponsoredDraft({ ...draft(), images: [image] }).images,
    ).toEqual([image]);
    expect(() =>
      normalizeSponsoredDraft({ ...draft(), images: [image, image] }),
    ).toThrow();
    expect(() =>
      normalizeSponsoredDraft({ ...draft(), content: 'x'.repeat(2501) }),
    ).toThrow();
    expect(() =>
      normalizeSponsoredDraft({ ...draft(), content: '' }),
    ).toThrow();
    expect(() =>
      normalizeSponsoredDraft({
        ...draft(),
        images: [image, image, image, image],
      }),
    ).toThrow();
  });

  const allowed: Record<Action, readonly Status[]> = {
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
  };
  for (const status of Object.values(Status)) {
    for (const action of Object.values(Action)) {
      it(`${status} / ${action} follows SRS 10.5`, () => {
        const record = state(status);
        const time = action === Action.EXPIRE ? record.endAt : now;
        if (allowed[action].includes(status)) {
          expect(() => nextSponsoredStatus(record, action, time)).not.toThrow();
        } else {
          expect(() => nextSponsoredStatus(record, action, time)).toThrow(
            ConflictException,
          );
        }
      });
    }
  }
  it('activation is inclusive at start and exclusive at end', () => {
    const record = state(Status.SCHEDULED);
    expect(() =>
      nextSponsoredStatus(record, Action.ACTIVATE, new Date(now.getTime() - 1)),
    ).toThrow();
    expect(nextSponsoredStatus(record, Action.ACTIVATE, now)).toBe(
      Status.ACTIVE,
    );
    expect(() =>
      nextSponsoredStatus(record, Action.ACTIVATE, record.endAt),
    ).toThrow();
  });
  it.each([Health.UNKNOWN, Health.MISSING, Health.CORRUPT])(
    'fails closed for %s asset health',
    (health) => {
      expect(() =>
        nextSponsoredStatus(
          { ...state(Status.PAUSED), assetHealth: health },
          Action.RESUME,
          now,
        ),
      ).toThrow();
    },
  );
  it('restores only to draft, rejects restore after schedule end and premature expiry', () => {
    expect(
      nextSponsoredStatus(state(Status.DELETED), Action.RESTORE, now),
    ).toBe(Status.DRAFT);
    expect(() =>
      nextSponsoredStatus(
        state(Status.DELETED),
        Action.RESTORE,
        state(Status.DELETED).endAt,
      ),
    ).toThrow();
    expect(() =>
      nextSponsoredStatus(state(Status.ACTIVE), Action.EXPIRE, now),
    ).toThrow();
  });
});
