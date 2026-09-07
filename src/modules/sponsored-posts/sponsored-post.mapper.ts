import { type SponsoredPost } from './sponsored-post.schema';

/** Transport-safe campaign data. This is NOT a Feed eligibility decision. */
export function toPublicSponsoredPost(record: SponsoredPost) {
  return {
    id: record.publicId,
    publicId: record.publicId,
    content: record.content,
    images: record.images.map((image) => ({ url: image.url })),
    destinationUrl: record.destinationUrl,
    cta: record.cta,
    status: record.status,
    startAt: record.startAt.toISOString(),
    endAt: record.endAt.toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
