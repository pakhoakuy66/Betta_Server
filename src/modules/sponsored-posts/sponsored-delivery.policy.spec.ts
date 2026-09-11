import { describe, expect, it } from '@jest/globals';
import {
  DELIVERY,
  issueFeedSessionId,
  sessionDigest,
  uniqueIds,
  validPage,
} from './sponsored-delivery.policy';

describe('Sponsored delivery policy', () => {
  it('issues random opaque tokens and persists only a digest', () => {
    const first = issueFeedSessionId();
    expect(first).toMatch(/^fss_[A-Za-z0-9_-]{43}$/);
    expect(issueFeedSessionId()).not.toBe(first);
    expect(sessionDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionDigest(first)).toBe(sessionDigest(first));
  });
  it.each(['', 'user_123', 'fss_abc', null])(
    'rejects malformed token %s',
    (token) => {
      expect(() => sessionDigest(token as string)).toThrow();
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid page %s', (page) => {
    expect(() => validPage(page, 20)).toThrow();
  });
  it('bounds per-request work without a session campaign count cap', () => {
    expect(() => validPage(99999, 100)).not.toThrow();
    expect(() => validPage(1, 101)).toThrow();
    expect(DELIVERY.cooldownMs).toBe(86400000);
    expect(DELIVERY.sessionMs).toBeLessThan(DELIVERY.cooldownMs);
  });
  it('rejects duplicates and non-ID payloads', () => {
    expect(() => uniqueIds(['a', 'a'], /^a$/, 3)).toThrow();
    expect(() => uniqueIds(['secret'], /^a$/, 3)).toThrow();
  });
});
