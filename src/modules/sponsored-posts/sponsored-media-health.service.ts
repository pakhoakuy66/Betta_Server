import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { type Connection, type Model } from 'mongoose';
import { SponsoredPost, SPONSORED_WRITE } from './sponsored-post.schema';
import {
  SponsoredAssetHealth as Health,
  SponsoredPostStatus as Status,
} from './sponsored-post.constants';
import { SponsoredMediaCloudService } from './sponsored-media-cloud.service';
import { SponsoredMediaAsset } from './sponsored-media-asset.schema';
import { AdminAuditService } from '../admin/services/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../admin/constants/admin-audit.constants';

@Injectable()
export class SponsoredMediaHealthService {
  private running = false;
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
    @InjectModel(SponsoredMediaAsset.name)
    private readonly assets: Model<SponsoredMediaAsset>,
    private readonly cloud: SponsoredMediaCloudService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Worker only. Feed consumers read persisted health, never call Cloudinary. */
  async refresh(publicId: string): Promise<void> {
    const snapshot = await this.posts
      .findOne({
        publicId,
        status: {
          $in: [Status.DRAFT, Status.SCHEDULED, Status.ACTIVE, Status.PAUSED],
        },
      })
      .lean();
    if (!snapshot) return;
    let health = Health.HEALTHY;
    try {
      for (const image of snapshot.images) {
        const result = await this.cloud.health(image.publicId);
        if (result !== 'healthy') {
          health = result === 'missing' ? Health.MISSING : Health.CORRUPT;
          break;
        }
      }
    } catch {
      health = Health.UNKNOWN;
    }
    await this.connection.transaction(async (session) => {
      const post = await this.posts
        .findOne({ publicId, version: snapshot.version })
        .select('+assetHealth +statusReason +ownerPublicId')
        .session(session);
      if (!post) return; // A concurrent replace wins; never write a stale probe.
      // Fence health publication against cleanup. A retiring asset can never
      // become eligible again even if its remote deletion is still in flight.
      for (const image of post.images) {
        const result = await this.assets.updateOne(
          {
            campaignPublicId: publicId,
            remoteId: image.publicId,
            state: 'attached',
          },
          { $inc: { healthSequence: 1 } },
          { session },
        );
        if (result.matchedCount !== 1) health = Health.MISSING;
      }
      post.assetHealth = health;
      post.assetHealthCheckedAt = new Date();
      if (
        [Health.MISSING, Health.CORRUPT].includes(health) &&
        post.status === Status.ACTIVE
      ) {
        post.status = Status.PAUSED;
        post.statusReason = 'asset_unavailable';
      }
      post.$locals.sponsoredWrite = SPONSORED_WRITE;
      post.$session(session);
      await post.save();
      await this.audit.record({
        action:
          post.status !== snapshot.status
            ? AdminAuditAction.SPONSORED_PAUSED
            : AdminAuditAction.SPONSORED_UPDATED,
        outcome: AdminAuditOutcome.SUCCEEDED,
        actor: {
          type: AdminAuditActorType.SYSTEM,
          displayName: 'Sponsored asset health worker',
        },
        target: { type: AdminAuditTargetType.SPONSORED_POST, publicId },
        reasonCode: 'asset_health_checked',
        source: AdminAuditSource.WORKER,
        metadata: {
          beforeVersion: snapshot.version,
          afterVersion: post.version,
          beforeState: snapshot.status,
          afterState: post.status,
        },
        mongoSession: session,
      });
    });
  }

  @Cron('0 */5 * * * *')
  async refreshBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.posts
        .find({
          status: { $in: [Status.SCHEDULED, Status.ACTIVE, Status.PAUSED] },
        })
        .sort({ assetHealthCheckedAt: 1, publicId: 1 })
        .limit(5)
        .select('publicId')
        .lean();
      for (const candidate of candidates)
        await this.refresh(candidate.publicId);
    } finally {
      this.running = false;
    }
  }
}
