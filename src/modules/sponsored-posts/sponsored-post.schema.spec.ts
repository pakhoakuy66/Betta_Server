import { describe, expect, it } from '@jest/globals';
import { model } from 'mongoose';
import {
  SPONSORED_INDEXES,
  SPONSORED_PUBLIC_ID_PATTERN,
  SponsoredPostStatus,
} from './sponsored-post.constants';
import { SponsoredPost, SponsoredPostSchema } from './sponsored-post.schema';
import { toPublicSponsoredPost } from './sponsored-post.mapper';

const Model = model<SponsoredPost>(
  'SponsoredSchemaUnit',
  SponsoredPostSchema.clone(),
);
const data = () => ({
  ownerPublicId: 'adm_23456789ABCD',
  content: 'Example',
  images: [
    {
      url: 'https://res.cloudinary.com/demo/image/upload/v1/banner.jpg',
      publicId: 'sponsored/banner',
    },
  ],
  destinationUrl: 'https://example.com',
  cta: 'Learn more',
  startAt: new Date('2035-01-01T00:00:00Z'),
  endAt: new Date('2035-01-02T00:00:00Z'),
});

describe('SADM-SPON-01 schema and public projection', () => {
  it('is a separate strict collection with unique public ID and no organic/TTL fields', async () => {
    const document = new Model(data());
    await document.validate();
    expect(document.publicId).toMatch(SPONSORED_PUBLIC_ID_PATTERN);
    expect(document.status).toBe(SponsoredPostStatus.DRAFT);
    expect(document.version).toBe(0);
    expect(Model.collection.collectionName).toBe('sponsored_posts');
    for (const key of [
      'expireAt',
      'authorId',
      'streakCount',
      'likeCount',
      'shareCount',
    ]) {
      expect(SponsoredPostSchema.path(key)).toBeUndefined();
    }
    const indexes = SponsoredPostSchema.indexes();
    expect(indexes.map(([, options]) => options.name)).toEqual(
      Object.values(SPONSORED_INDEXES),
    );
    expect(
      indexes.every(([, options]) => options.expireAfterSeconds === undefined),
    ).toBe(true);
  });
  it('validates duration and deletion metadata on the entire document', async () => {
    await expect(
      new Model({
        ...data(),
        endAt: new Date('2035-01-01T12:00:00Z'),
      }).validate(),
    ).rejects.toThrow();
    await expect(
      new Model({ ...data(), status: SponsoredPostStatus.DELETED }).validate(),
    ).rejects.toThrow();
    expect(() => new Model({ ...data(), expireAt: new Date() })).toThrow();
  });
  it('requires an audited transactional writer for saves and query mutations', async () => {
    await expect(new Model(data()).save()).rejects.toThrow(
      'SPONSORED_AUDITED_WRITER_REQUIRED',
    );
    await expect(
      Model.updateOne({}, { $set: { status: 'active' } }),
    ).rejects.toThrow('SPONSORED_AUDITED_WRITER_REQUIRED');
    await expect(Model.deleteMany({})).rejects.toThrow(
      'SPONSORED_AUDITED_WRITER_REQUIRED',
    );
    await expect(Model.bulkWrite([])).rejects.toThrow(
      'SPONSORED_AUDITED_WRITER_REQUIRED',
    );
  });
  it('maps only public fields, never owner identity or media identifiers', () => {
    const document = new Model(data());
    document.createdAt = new Date('2035-01-01T00:00:00Z');
    document.updatedAt = new Date(document.createdAt);
    const result = toPublicSponsoredPost(document);
    expect(Object.keys(result)).toEqual([
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
    ]);
    expect(result.images).toEqual([{ url: data().images[0].url }]);
    expect(JSON.stringify(result)).not.toContain('adm_');
    expect(JSON.stringify(result)).not.toContain('sponsored/banner');
  });
});
