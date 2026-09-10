import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createConnection, type Connection, type Model } from 'mongoose';
import {
  SponsoredPost,
  SponsoredPostSchema,
} from '../../src/modules/sponsored-posts/sponsored-post.schema';
import {
  generateSponsoredPublicId,
  SponsoredPostStatus as Status,
} from '../../src/modules/sponsored-posts/sponsored-post.constants';
import {
  SponsoredPostQueryDto,
  SponsoredSortField,
  SponsoredSortOrder,
} from '../../src/modules/sponsored-posts/sponsored-post-query.dto';
import {
  sponsoredReadPlan,
  SPONSORED_READ_PROJECTION,
  SponsoredPostQueryService,
} from '../../src/modules/sponsored-posts/sponsored-post-query.service';

const databaseName = `betta_sq_it_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
describe('SADM-SPON-07 MongoDB list/detail and indexed large dataset', () => {
  let connection: Connection | undefined;
  let posts: Model<SponsoredPost>;
  let reader: SponsoredPostQueryService;
  const baseTime = new Date('2026-01-01T00:00:00Z');
  const ids = Array.from({ length: 3000 }, () => generateSponsoredPublicId());
  beforeAll(async () => {
    const uri = process.env.MONGODB_INTEGRATION_URI?.trim();
    if (!uri || process.env.RUN_MONGODB_INTEGRATION_TESTS !== 'YES')
      throw new Error('Dedicated test URI and YES are required');
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI].some(
        (value) => value?.trim() === uri,
      )
    )
      throw new Error('Runtime URI is forbidden');
    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15000,
    }).asPromise();
    posts = connection.model(SponsoredPost.name, SponsoredPostSchema);
    await posts.createIndexes();
    // Raw writes are synthetic test setup ONLY in this randomly named disposable database.
    await posts.collection.insertMany(
      ids.map((publicId, index) => {
        const status = Object.values(Status)[index % 6];
        return {
          publicId,
          ownerPublicId: 'adm_23456789ABCD',
          content: `Synthetic ${index}`,
          images: [
            {
              url: 'https://res.cloudinary.com/fixture/image/upload/test.webp',
              publicId: 'private-remote-id',
            },
          ],
          destinationUrl: 'https://example.com/offer',
          cta: 'Learn more',
          startAt: new Date(
            baseTime.getTime() + Math.floor(index / 12) * 86400000,
          ),
          endAt: new Date(
            baseTime.getTime() + (Math.floor(index / 12) + 2) * 86400000,
          ),
          createdAt: baseTime,
          updatedAt: baseTime,
          version: 0,
          status,
          deletedAt: status === Status.DELETED ? baseTime : null,
          assetHealth: 'healthy',
          statusReason: 'fixture_created',
        };
      }),
    );
    reader = new SponsoredPostQueryService(posts);
  }, 120000);
  afterAll(async () => {
    if (!connection) return;
    try {
      if (
        Number(connection.readyState) === 1 &&
        connection.name === databaseName &&
        /^betta_sq_it_[a-f0-9]{16}$/.test(databaseName)
      )
        await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  }, 30000);

  it('paginates deterministically with publicId tie-breaker and no duplicates', async () => {
    const sorted = [...ids].sort().reverse();
    const first = await reader.list(new SponsoredPostQueryDto());
    const second = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), { page: 2 }),
    );
    expect(
      [...first.items, ...second.items].map((item) => item.publicId),
    ).toEqual(sorted.slice(0, 40));
    expect(first.pagination.hasMore).toBe(true);
    const last = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), { page: 150 }),
    );
    expect(last.items).toHaveLength(20);
    expect(last.pagination.hasMore).toBe(false);
    const empty = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), { page: 151 }),
    );
    expect(empty.items).toEqual([]);
    expect(empty.pagination.hasMore).toBe(false);
  });
  it('maps deleted campaign and private fields safely without owner scoping', async () => {
    const result = await reader.detail(ids[5]);
    expect(result.status).toBe(Status.DELETED);
    expect(result.deletedAt).toBe(baseTime.toISOString());
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'publicId',
        'content',
        'images',
        'destinationUrl',
        'cta',
        'status',
        'startAt',
        'endAt',
        'deletedAt',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(result.images).toEqual([
      { url: 'https://res.cloudinary.com/fixture/image/upload/test.webp' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /ownerPublicId|private-remote-id|assetHealth|statusReason|_id/,
    );
    await expect(reader.detail(generateSponsoredPublicId())).rejects.toThrow(
      'SPONSORED_POST_NOT_FOUND',
    );
  });
  it('filters exact public ID/status and inclusive UTC schedule ranges', async () => {
    const exact = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), {
        publicId: ids[5],
        status: Status.DELETED,
      }),
    );
    expect(exact.items.map((item) => item.publicId)).toEqual([ids[5]]);
    const mismatched = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), {
        publicId: ids[5],
        status: Status.DRAFT,
      }),
    );
    expect(mismatched.items).toEqual([]);
    const bounded = await reader.list(
      Object.assign(new SponsoredPostQueryDto(), {
        sortBy: SponsoredSortField.START,
        from: baseTime.toISOString(),
        to: baseTime.toISOString(),
      }),
    );
    expect(bounded.items).toHaveLength(12);
    expect(
      bounded.items.every((item) => item.startAt === baseTime.toISOString()),
    ).toBe(true);
  });
  it('rejects reversed date interval and expensive skip before querying', async () => {
    await expect(
      reader.list(
        Object.assign(new SponsoredPostQueryDto(), { page: 102, limit: 100 }),
      ),
    ).rejects.toThrow('SPONSORED_PAGE_WINDOW_EXCEEDED');
    await expect(
      reader.list(
        Object.assign(new SponsoredPostQueryDto(), {
          from: '2026-02-01T00:00:00Z',
          to: '2026-01-01T00:00:00Z',
        }),
      ),
    ).rejects.toThrow('SPONSORED_DATE_RANGE_INVALID');
  });
  it('uses indexed scans without blocking sort for every exposed sort/status combination', async () => {
    for (const sortBy of Object.values(SponsoredSortField)) {
      for (const order of Object.values(SponsoredSortOrder)) {
        for (const status of [undefined, Status.ACTIVE]) {
          const query = Object.assign(new SponsoredPostQueryDto(), {
            sortBy,
            order,
            status,
          });
          const { filter, sort } = sponsoredReadPlan(query);
          const plan = await posts
            .find(filter)
            .select(SPONSORED_READ_PROJECTION)
            .sort(sort)
            .limit(21)
            .maxTimeMS(5000)
            .explain('executionStats');
          const execution = plan as unknown as {
            queryPlanner: { winningPlan: unknown };
            executionStats: { totalDocsExamined: number; nReturned: number };
          };
          const serialized = JSON.stringify(execution.queryPlanner.winningPlan);
          expect(serialized).not.toMatch(/"stage":"(?:COLLSCAN|SORT)"/);
          expect(
            execution.executionStats.totalDocsExamined,
          ).toBeLessThanOrEqual(50);
          expect(execution.executionStats.nReturned).toBe(21);
        }
      }
    }
    const indexes = await posts.collection.indexes();
    expect(
      indexes.some((index) => index.expireAfterSeconds !== undefined),
    ).toBe(false);
  }, 120000);
});
