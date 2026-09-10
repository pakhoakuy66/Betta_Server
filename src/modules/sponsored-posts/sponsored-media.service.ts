import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Connection, type Model } from 'mongoose';
import { OutboxService } from '../../common/outbox/outbox.service';
import {
  OutboxPermanentError,
  OutboxRetryLaterError,
} from '../../common/outbox/outbox.errors';
import { AdminAuditService } from '../admin/services/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../admin/constants/admin-audit.constants';
import type { AdminRequestPrincipal } from '../admin/types/admin-authenticated-request';
import { AdminPermission } from '../admin/constants/admin-permission.constants';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';
import { SPONSORED_WRITE, SponsoredPost } from './sponsored-post.schema';
import {
  SponsoredAssetHealth as Health,
  SponsoredPostStatus as Status,
  SPONSORED_PUBLIC_ID_PATTERN,
} from './sponsored-post.constants';
import { SponsoredMediaAsset } from './sponsored-media-asset.schema';
import { SponsoredMediaCloudService } from './sponsored-media-cloud.service';
import {
  normalizeSponsoredMedia,
  type SponsoredUpload,
} from './sponsored-media.policy';
import { toPublicSponsoredPost } from './sponsored-post.mapper';

@Injectable()
export class SponsoredMediaService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SponsoredPost.name)
    private readonly posts: Model<SponsoredPost>,
    @InjectModel(SponsoredMediaAsset.name)
    private readonly assets: Model<SponsoredMediaAsset>,
    private readonly writer: SponsoredPostWriterService,
    private readonly cloud: SponsoredMediaCloudService,
    private readonly outbox: OutboxService,
    private readonly audit: AdminAuditService,
  ) {}

  async replace(
    actor: AdminRequestPrincipal,
    publicId: string,
    version: number,
    files: readonly SponsoredUpload[],
  ) {
    if (
      !SPONSORED_PUBLIC_ID_PATTERN.test(publicId) ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version >= 100000 ||
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > 3
    )
      throw new BadRequestException('SPONSORED_MEDIA_REQUEST_INVALID');
    await this.connection.transaction(async (session) => {
      await this.writer.authorizeMedia(actor, session);
      const post = await this.posts.findOne({ publicId }).session(session);
      if (!post) throw new NotFoundException('SPONSORED_POST_NOT_FOUND');
      this.editable(post, version);
    });
    // Sequential decode keeps peak memory bounded to a single decoded image.
    const buffers: Buffer[] = [];
    for (const file of files as readonly SponsoredUpload[])
      buffers.push(await normalizeSponsoredMedia(file));
    const records = buffers.map(() => {
      const id = `sma_${randomUUID().replace(/-/g, '')}`;
      return {
        publicId: id,
        campaignPublicId: publicId,
        remoteId: this.cloud.remoteId(id),
        state: 'uploading' as const,
        cleanupAfter: new Date(Date.now() + 15 * 60_000),
      };
    });
    await this.connection.transaction(async (session) => {
      await this.writer.authorizeMedia(actor, session);
      await this.assets.insertMany(records, { session });
      for (const record of records)
        await this.outbox.enqueue({
          eventType: 'sponsored.media.cleanup',
          dedupeKey: `sponsored.reserve.${record.publicId}`,
          aggregateType: 'sponsored_post',
          aggregatePublicId: publicId,
          payload: { assetId: record.publicId },
          availableAt: record.cleanupAfter,
          mongoSession: session,
        });
    });
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      // Upload errors retain the durable reservation. Ambiguous remote writes
      // require review; never interpret a timeout as proof that no asset exists.
      const url = await this.cloud.upload(record.remoteId, buffers[i]);
      const result = await this.assets.updateOne(
        {
          publicId: record.publicId,
          state: 'uploading',
          cleanupAfter: { $gt: new Date() },
        },
        { $set: { state: 'ready', url } },
      );
      if (result.modifiedCount !== 1)
        throw new ConflictException('SPONSORED_UPLOAD_RESERVATION_EXPIRED');
    }
    return this.connection.transaction(async (session) => {
      await this.writer.authorizeMedia(actor, session);
      const post = await this.posts
        .findOne({ publicId })
        .select('+assetHealth +ownerPublicId +statusReason')
        .session(session);
      if (!post) throw new NotFoundException('SPONSORED_POST_NOT_FOUND');
      this.editable(post, version);
      const images: { publicId: string; url: string }[] = [];
      for (const record of records) {
        const asset = await this.assets.findOneAndUpdate(
          {
            publicId: record.publicId,
            state: 'ready',
            cleanupAfter: { $gt: new Date() },
          },
          { $set: { state: 'attached' } },
          { session, returnDocument: 'after' },
        );
        if (!asset) throw new ConflictException('SPONSORED_ASSET_NOT_READY');
        images.push({ publicId: asset.remoteId, url: asset.url });
      }
      post.images = images;
      post.assetHealth = Health.HEALTHY;
      post.assetHealthCheckedAt = new Date();
      post.$locals.sponsoredWrite = SPONSORED_WRITE;
      post.$session(session);
      await post.save();
      await this.audit.record({
        action: AdminAuditAction.SPONSORED_UPDATED,
        outcome: AdminAuditOutcome.SUCCEEDED,
        actor: {
          type: AdminAuditActorType.ADMIN_ACCOUNT,
          publicId: actor.publicId,
          role: actor.role,
          displayName: actor.displayName,
          username: actor.username,
          permissionVersion: actor.permissionVersion,
          permission: AdminPermission.SPONSORED_POSTS_UPDATE,
        },
        target: { type: AdminAuditTargetType.SPONSORED_POST, publicId },
        reasonCode: 'media_replaced',
        source: AdminAuditSource.HTTP,
        metadata: { beforeVersion: version, afterVersion: post.version },
        mongoSession: session,
      });
      await this.outbox.enqueue({
        eventType: 'sponsored.media.cleanup',
        dedupeKey: `sponsored.replace.${publicId}.${post.version}`,
        aggregateType: 'sponsored_post',
        aggregatePublicId: publicId,
        payload: {},
        mongoSession: session,
      });
      return toPublicSponsoredPost(post);
    });
  }

  private editable(post: SponsoredPost, version: number) {
    if (post.version !== version)
      throw new ConflictException('SPONSORED_VERSION_CONFLICT');
    if (![Status.DRAFT, Status.PAUSED].includes(post.status))
      throw new ConflictException('SPONSORED_PAUSE_BEFORE_MEDIA_EDIT');
  }

  async cleanup(campaignPublicId: string, assetId?: string): Promise<void> {
    const records = await this.assets
      .find({
        campaignPublicId,
        ...(assetId ? { publicId: assetId } : {}),
        state: { $nin: ['deleted', 'manual_review'] },
      })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    for (const record of records) {
      const removable = await this.connection.transaction(async (session) => {
        const current = await this.assets
          .findOne({ publicId: record.publicId })
          .session(session);
        if (!current || current.state === 'deleted') return false;
        if (current.state === 'manual_review') return false;
        if (current.state === 'uploading') {
          if (current.cleanupAfter > new Date()) return false;
          await this.assets.updateOne(
            { publicId: current.publicId, state: 'uploading' },
            { $set: { state: 'manual_review' } },
            { session },
          );
          return false;
        }
        if (current.state === 'ready' && current.cleanupAfter > new Date())
          return false;
        const referenced = await this.posts
          .exists({
            publicId: campaignPublicId,
            status: { $ne: Status.DELETED },
            'images.publicId': current.remoteId,
          })
          .session(session);
        if (referenced) return false;
        await this.assets.updateOne(
          { publicId: current.publicId, state: current.state },
          { $set: { state: 'deleting' } },
          { session },
        );
        return true;
      });
      if (removable) {
        await this.cloud.destroy(record.remoteId);
        await this.assets.updateOne(
          { publicId: record.publicId, state: 'deleting' },
          { $set: { state: 'deleted' } },
        );
      }
    }
    if (records.length === 100)
      throw new OutboxRetryLaterError(
        'SPONSORED_CLEANUP_HAS_MORE',
        'Continue bounded cleanup',
        new Date(Date.now() + 60_000),
      );
    if (
      await this.assets.exists({
        campaignPublicId,
        ...(assetId ? { publicId: assetId } : {}),
        state: 'manual_review',
      })
    )
      throw new OutboxPermanentError(
        'SPONSORED_UPLOAD_MANUAL_REVIEW',
        'Upload needs review',
      );
  }
}
