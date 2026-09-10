import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import {
  SponsoredPostQueryDto,
  SponsoredPostQueryParams,
  SponsoredSortField,
} from './sponsored-post-query.dto';
import { sponsoredReadPlan } from './sponsored-post-query.service';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const parse = (input: unknown): Promise<SponsoredPostQueryDto> =>
  pipe.transform(input, { type: 'query', metatype: SponsoredPostQueryDto });
describe('SADM-SPON-07 query validation and plan', () => {
  it('defaults to bounded newest-first Package A pagination', async () => {
    const query = await parse({});
    expect(query.page).toBe(1);
    expect(query.limit).toBe(20);
    expect(sponsoredReadPlan(query)).toEqual({
      filter: {},
      sort: { createdAt: -1, publicId: -1 },
      skip: 0,
    });
  });
  it.each([
    '',
    ' ',
    '0',
    '-1',
    '1.5',
    '1e2',
    '01',
    '10002',
    ['1', '2'],
    { $gt: 0 },
    null,
  ])('rejects page %j', async (page) => {
    await expect(parse({ page })).rejects.toThrow();
  });
  it.each([
    { limit: '101' },
    { status: { $ne: 'deleted' } },
    { status: 'ALL' },
    { sortBy: '$where' },
    { order: '-1' },
    { publicId: 'post_23456789ABCD' },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-01-01' },
    { from: '2026-01-01T00:00:00+07:00' },
    { from: null },
    { cursor: 'legacy' },
    { title: 'unsupported' },
    { $where: 'true' },
    { 'status[$ne]': 'deleted' },
    { projection: '+ownerPublicId' },
  ])('rejects non-allowlisted query %j', async (input) => {
    await expect(parse(input)).rejects.toThrow();
  });
  it('validates ranges and total skip independently of page/limit bounds', async () => {
    expect(() =>
      sponsoredReadPlan(
        Object.assign(new SponsoredPostQueryDto(), { page: 102, limit: 100 }),
      ),
    ).toThrow('SPONSORED_PAGE_WINDOW_EXCEEDED');
    expect(() =>
      sponsoredReadPlan(
        Object.assign(new SponsoredPostQueryDto(), {
          from: '2026-02-01T00:00:00Z',
          to: '2026-01-01T00:00:00Z',
        }),
      ),
    ).toThrow('SPONSORED_DATE_RANGE_INVALID');
    const query = await parse({
      sortBy: 'startAt',
      order: 'asc',
      from: '2026-01-01T00:00:00Z',
      page: '2',
      limit: '10',
    });
    expect(query.sortBy).toBe(SponsoredSortField.START);
    expect(sponsoredReadPlan(query)).toEqual({
      filter: { startAt: { $gte: new Date('2026-01-01T00:00:00Z') } },
      sort: { startAt: 1, publicId: 1 },
      skip: 10,
    });
  });
  it('rejects organic or internal IDs in detail', async () => {
    for (const publicId of ['post_23456789ABCD', '012345678901234567890123']) {
      await expect(
        pipe.transform(
          { publicId },
          { type: 'param', metatype: SponsoredPostQueryParams },
        ),
      ).rejects.toThrow();
    }
  });
});
