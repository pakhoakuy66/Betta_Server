import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SponsoredPost } from './sponsored-post.schema';
import { SponsoredMediaAsset } from './sponsored-media-asset.schema';
import { SponsoredMediaCloudService } from './sponsored-media-cloud.service';
import { SponsoredAssetHealth as Health } from './sponsored-post.constants';
import { SponsoredSchedulerStore } from './sponsored-scheduler.store';
import type { SponsoredTransitionExecution } from './sponsored-post-writer.service';

export type SponsoredHealthProof = Readonly<{
  publicId: string;
  version: number;
  checkedAt: Date;
}>;
@Injectable()
export class SponsoredActivationService {
  constructor(
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
    @InjectModel(SponsoredMediaAsset.name)
    private readonly assets: Model<SponsoredMediaAsset>,
    private readonly cloud: SponsoredMediaCloudService,
    private readonly store: SponsoredSchedulerStore,
  ) {}
  /** External I/O must never run inside a retryable MongoDB transaction. */
  async probe(
    publicId: string,
    version: number,
  ): Promise<SponsoredHealthProof> {
    const post = await this.posts
      .findOne({ publicId })
      .select('+assetHealth')
      .lean()
      .exec();
    if (!post) throw new NotFoundException('SPONSORED_POST_NOT_FOUND');
    if (post.version !== version)
      throw new ConflictException('SPONSORED_VERSION_CONFLICT');
    if ([Health.MISSING, Health.CORRUPT].includes(post.assetHealth))
      throw new ConflictException('SPONSORED_REUPLOAD_REQUIRED');
    const checkedAt = await this.store.now();
    for (const asset of post.images) {
      if ((await this.cloud.health(asset.publicId)) !== 'healthy')
        throw new ConflictException('SPONSORED_NOT_ELIGIBLE');
    }
    return { publicId, version, checkedAt };
  }
  execution(
    proof: SponsoredHealthProof | undefined,
    now: Date,
  ): SponsoredTransitionExecution {
    return {
      now,
      ...(proof
        ? {
            prepare: async (post, session) => {
              const age = now.getTime() - proof.checkedAt.getTime();
              if (
                post.publicId !== proof.publicId ||
                post.version !== proof.version ||
                age < 0 ||
                age > 60000
              )
                throw new ConflictException('SPONSORED_HEALTH_PROOF_STALE');
              for (const asset of post.images) {
                const result = await this.assets.updateOne(
                  {
                    campaignPublicId: post.publicId,
                    remoteId: asset.publicId,
                    state: 'attached',
                  },
                  { $inc: { healthSequence: 1 } },
                  { session },
                );
                if (result.matchedCount !== 1)
                  throw new ConflictException('SPONSORED_NOT_ELIGIBLE');
              }
              post.assetHealth = Health.HEALTHY;
              post.assetHealthCheckedAt = now;
            },
          }
        : {}),
    };
  }
}
