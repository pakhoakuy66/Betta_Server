import { describe, expect, it } from '@jest/globals';
import {
  getRecapWeekIdentity,
  getRecapWeekKey,
  getRecapWeekRange,
} from './recap-week.util';

describe('recap week util', () => {
  it('returns Monday 00:00 Asia/Ho_Chi_Minh as Sunday 17:00 UTC', () => {
    const monday0030Vietnam = new Date('2026-06-28T17:30:00.000Z');

    const { weekStart, weekEnd } = getRecapWeekRange(monday0030Vietnam);

    expect(weekStart.toISOString()).toBe('2026-06-28T17:00:00.000Z');
    expect(weekEnd.toISOString()).toBe('2026-07-05T17:00:00.000Z');
    expect(getRecapWeekKey(weekStart)).toBe('2026-06-29');
  });

  it('keeps Sunday 23:59 Asia/Ho_Chi_Minh in the current week', () => {
    const sunday2359Vietnam = new Date('2026-07-05T16:59:00.000Z');

    const { weekStart, weekEnd } = getRecapWeekRange(sunday2359Vietnam);

    expect(weekStart.toISOString()).toBe('2026-06-28T17:00:00.000Z');
    expect(weekEnd.toISOString()).toBe('2026-07-05T17:00:00.000Z');
    expect(getRecapWeekKey(weekStart)).toBe('2026-06-29');
  });

  it('moves to the next week at Monday 00:00 Asia/Ho_Chi_Minh', () => {
    const nextMondayVietnam = new Date('2026-07-05T17:00:00.000Z');

    const { weekStart, weekEnd } = getRecapWeekRange(nextMondayVietnam);

    expect(weekStart.toISOString()).toBe('2026-07-05T17:00:00.000Z');
    expect(weekEnd.toISOString()).toBe('2026-07-12T17:00:00.000Z');
    expect(getRecapWeekKey(weekStart)).toBe('2026-07-06');
  });

  it('calculates ISO week identity from Vietnam week start', () => {
    const { weekStart } = getRecapWeekRange(
      new Date('2026-07-02T06:45:00.000Z'),
    );

    expect(getRecapWeekIdentity(weekStart)).toEqual({
      year: 2026,
      weekNumber: 27,
      weekKey: '2026-06-29',
    });
  });
});
