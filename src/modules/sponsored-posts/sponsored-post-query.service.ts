import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type QueryFilter } from 'mongoose';
import { SponsoredPost } from './sponsored-post.schema';
import { toPublicSponsoredPost } from './sponsored-post.mapper';
import {
  SponsoredPostQueryDto,
  SponsoredSortOrder,
} from './sponsored-post-query.dto';

// Inclusion projection: new private fields stay private without updating a denylist.
export const SPONSORED_READ_PROJECTION = Object.freeze({
  _id: 0,
  publicId: 1,
  content: 1,
  'images.url': 1,
  destinationUrl: 1,
  cta: 1,
  status: 1,
  startAt: 1,
  endAt: 1,
  deletedAt: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});

export function sponsoredReadPlan(query: SponsoredPostQueryDto) {
  const skip = (query.page - 1) * query.limit;
  if (!Number.isSafeInteger(skip) || skip < 0 || skip > 10000)
    throw new BadRequestException('SPONSORED_PAGE_WINDOW_EXCEEDED');
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
    throw new BadRequestException('SPONSORED_DATE_RANGE_INVALID');
  const filter: QueryFilter<SponsoredPost> = {};
  if (query.status !== undefined) filter.status = query.status;
  if (query.publicId !== undefined) filter.publicId = query.publicId;
  if (query.from || query.to)
    filter[query.sortBy] = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lte: new Date(query.to) } : {}),
    };
  const direction: 1 | -1 = query.order === SponsoredSortOrder.ASC ? 1 : -1;
  const sort: Record<string, 1 | -1> = {
    [query.sortBy]: direction,
    publicId: direction,
  };
  return { filter, sort, skip };
}

@Injectable()
export class SponsoredPostQueryService {
  constructor(
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
  ) {}

  async list(query: SponsoredPostQueryDto) {
    const { filter, sort, skip } = sponsoredReadPlan(query);
    const records = await this.posts
      .find(filter)
      .select(SPONSORED_READ_PROJECTION)
      .sort(sort)
      .skip(skip)
      .limit(query.limit + 1)
      .maxTimeMS(5000)
      .lean()
      .exec();
    return {
      items: records.slice(0, query.limit).map(toPublicSponsoredPost),
      pagination: {
        page: query.page,
        limit: query.limit,
        hasMore: records.length > query.limit,
      },
    };
  }

  async detail(publicId: string) {
    const record = await this.posts
      .findOne({ publicId })
      .select(SPONSORED_READ_PROJECTION)
      .maxTimeMS(5000)
      .lean()
      .exec();
    if (!record) throw new NotFoundException('SPONSORED_POST_NOT_FOUND');
    // Deleted campaigns remain visible to authorized administrators; this is not a Feed mapper.
    return toPublicSponsoredPost(record);
  }
}
