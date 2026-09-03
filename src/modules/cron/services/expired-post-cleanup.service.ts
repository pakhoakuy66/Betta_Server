import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  Post,
  PostCleanupStatus,
  PostModerationState,
} from '../../posts/schemas/post.schema';
import {
  Report,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import {
  ADMIN_POLICY,
  type AdminPolicy,
} from '../../admin/config/admin-policy.config';
import { User } from '../../users/schemas/user.schema';
import { UploadsService } from '../../uploads/services/uploads.service';

type ExpiredPostCleanupTarget = {
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  images: { url: string; publicId: string }[];
  moderationState: PostModerationState;
  moderationVersion: number;
  moderationNoticeVersion: number;
  evidenceHoldUntil: Date | null;
  cleanupLockToken: string;
};

type StoredRetentionHold = Readonly<{
  retentionHold?: Readonly<{ expiresAt?: Date | null }> | null;
}>;

export type RequestedPostCleanupResult =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'NOT_REQUIRED'
  | 'REQUIRES_INTERVENTION'
  | Readonly<{ status: 'RETRY_LATER'; retryAt: Date }>;

const STALE_DESTRUCTIVE_RESERVATION = 'STALE_DESTRUCTIVE_RESERVATION' as const;

@Injectable()
export class ExpiredPostCleanupService {
  private readonly logger = new Logger(ExpiredPostCleanupService.name);

  private readonly batchSize = 20;
  private readonly lockMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;

  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly uploadsService: UploadsService,
    @Optional()
    @InjectModel(Report.name)
    private readonly reportModel?: Model<Report>,
    @Optional()
    @Inject(ADMIN_POLICY)
    private readonly policy?: AdminPolicy,
  ) {}

  async cleanupExpiredPosts(): Promise<{
    processed: number;
    deleted: number;
    failed: number;
  }> {
    let processed = 0;
    let deleted = 0;
    let failed = 0;
    const reconciled = await this.reconcileStaleDestructiveReservations(
      new Date(),
      this.batchSize,
    );
    if (reconciled > 0) {
      this.logger.error(
        `Post cleanup moved stale destructive reservations to manual review. count=${reconciled}`,
      );
    }

    for (let index = 0; index < this.batchSize; index += 1) {
      const post = await this.claimNextExpiredPost();

      if (!post) break;

      processed += 1;

      try {
        if (!(await this.isEvidenceReleased(post))) {
          continue;
        }
        if (await this.cleanupOnePost(post)) deleted += 1;
      } catch (error) {
        failed += 1;
        await this.markCleanupFailed(post, error);
      }
    }

    if (processed > 0) {
      this.logger.log(
        `Expired post cleanup finished. processed=${processed}, deleted=${deleted}, failed=${failed}`,
      );
    }

    return { processed, deleted, failed };
  }

  async cleanupRequestedPost(
    postPublicId: string,
  ): Promise<RequestedPostCleanupResult> {
    const now = new Date();
    if (
      (await this.reconcileStaleDestructiveReservations(
        now,
        1,
        postPublicId,
      )) === 1
    ) {
      return 'REQUIRES_INTERVENTION';
    }

    const post = await this.claimNextExpiredPost(postPublicId);
    if (!post) {
      const current = await this.postModel
        .findOne({ publicId: postPublicId })
        .select(
          'moderationState cleanupStatus cleanupLockedUntil ' +
            '+cleanupDestructiveStartedAt evidenceHoldUntil',
        )
        .lean<{
          moderationState?: PostModerationState;
          cleanupStatus?: PostCleanupStatus;
          cleanupLockedUntil?: Date | null;
          cleanupDestructiveStartedAt?: Date | null;
          evidenceHoldUntil?: Date | null;
        } | null>()
        .exec();
      if (!current) return 'ALREADY_COMPLETED';
      if (current.moderationState !== PostModerationState.TERMINAL_DELETED) {
        return 'NOT_REQUIRED';
      }
      return current.cleanupStatus === PostCleanupStatus.MANUAL_REVIEW
        ? 'REQUIRES_INTERVENTION'
        : this.retryLater(current, now);
    }

    try {
      if (!(await this.isEvidenceReleased(post))) {
        return this.loadRetryLater(postPublicId);
      }
      return (await this.cleanupOnePost(post))
        ? 'COMPLETED'
        : this.loadRetryLater(postPublicId);
    } catch (error: unknown) {
      const state = await this.markCleanupFailed(post, error);
      if (state === PostCleanupStatus.MANUAL_REVIEW) {
        return 'REQUIRES_INTERVENTION';
      }
      const retryable = new Error('Post cleanup tạm thời thất bại') as Error & {
        code: string;
      };
      retryable.code = 'POST_CLEANUP_FAILED';
      throw retryable;
    }
  }

  private async reconcileStaleDestructiveReservations(
    now: Date,
    limit: number,
    publicId?: string,
  ): Promise<number> {
    const filter = {
      ...(publicId ? { publicId } : {}),
      cleanupStatus: PostCleanupStatus.PROCESSING,
      cleanupDestructiveStartedAt: { $type: 'date' as const },
      $or: [
        { cleanupLockedUntil: { $lte: now } },
        { cleanupLockedUntil: null },
        { cleanupLockedUntil: { $exists: false } },
      ],
    };
    const candidates = await this.postModel
      .find(filter)
      .sort({ cleanupLockedUntil: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<readonly Readonly<{ _id: Types.ObjectId }>[]>()
      .exec();
    if (candidates.length === 0) return 0;
    const result = await this.postModel.updateMany(
      {
        ...filter,
        _id: { $in: candidates.map(({ _id }) => _id) },
      },
      {
        $set: {
          cleanupStatus: PostCleanupStatus.MANUAL_REVIEW,
          cleanupLockedUntil: null,
          cleanupLockToken: null,
          cleanupLastError: STALE_DESTRUCTIVE_RESERVATION,
        },
      },
    );
    return result.modifiedCount;
  }

  private async loadRetryLater(
    postPublicId: string,
  ): Promise<Readonly<{ status: 'RETRY_LATER'; retryAt: Date }>> {
    const current = await this.postModel
      .findOne({ publicId: postPublicId })
      .select('cleanupLockedUntil evidenceHoldUntil')
      .lean<{
        cleanupLockedUntil?: Date | null;
        evidenceHoldUntil?: Date | null;
      } | null>()
      .exec();
    return this.retryLater(current ?? {}, new Date());
  }

  private retryLater(
    current: Readonly<{
      cleanupLockedUntil?: Date | null;
      evidenceHoldUntil?: Date | null;
    }>,
    now: Date,
  ): Readonly<{ status: 'RETRY_LATER'; retryAt: Date }> {
    const retryAt = [current.cleanupLockedUntil, current.evidenceHoldUntil]
      .filter(
        (value): value is Date =>
          value instanceof Date && value.getTime() > now.getTime(),
      )
      .reduce(
        (latest, value) =>
          value.getTime() > latest.getTime() ? value : latest,
        new Date(now.getTime() + 1_000),
      );
    return Object.freeze({ status: 'RETRY_LATER', retryAt });
  }

  private async claimNextExpiredPost(
    publicId?: string,
  ): Promise<ExpiredPostCleanupTarget | null> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + this.lockMs);
    const lockToken = randomUUID();

    return this.postModel
      .findOneAndUpdate(
        {
          $and: [
            ...(publicId
              ? [
                  {
                    publicId,
                    moderationState: PostModerationState.TERMINAL_DELETED,
                  },
                ]
              : []),
            {
              $or: [
                { cleanupDestructiveStartedAt: null },
                { cleanupDestructiveStartedAt: { $exists: false } },
              ],
            },
            {
              $or: [
                {
                  expireAt: { $lte: now },
                  moderationState: {
                    $ne: PostModerationState.TERMINAL_DELETED,
                  },
                },
                {
                  moderationState: PostModerationState.TERMINAL_DELETED,
                },
              ],
            },
            {
              $expr: {
                $gte: [
                  { $ifNull: ['$moderationNoticeVersion', 0] },
                  { $ifNull: ['$moderationVersion', 0] },
                ],
              },
            },
            {
              $or: [
                { evidenceHoldUntil: null },
                { evidenceHoldUntil: { $exists: false } },
                { evidenceHoldUntil: { $lte: now } },
              ],
            },
            {
              $or: [
                { cleanupAttempts: { $lt: this.maxAttempts } },
                { cleanupAttempts: { $exists: false } },
                { cleanupAttempts: null },
              ],
            },
            {
              $or: [
                { cleanupStatus: PostCleanupStatus.PENDING },
                { cleanupStatus: PostCleanupStatus.FAILED },
                { cleanupStatus: { $exists: false } },
                { cleanupStatus: null },
                { cleanupLockedUntil: { $lte: now } },
                { cleanupLockedUntil: null },
                { cleanupLockedUntil: { $exists: false } },
              ],
            },
          ],
        },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.PROCESSING,
            cleanupLockedUntil: lockUntil,
            cleanupLockToken: lockToken,
            cleanupLastError: null,
          },
          $inc: {
            cleanupAttempts: 1,
          },
        },
        {
          sort: { expireAt: 1 },
          returnDocument: 'after',
          projection: {
            _id: 1,
            publicId: 1,
            authorId: 1,
            images: 1,
            moderationState: 1,
            moderationVersion: 1,
            moderationNoticeVersion: 1,
            evidenceHoldUntil: 1,
            cleanupLockToken: 1,
          },
        },
      )
      .lean<ExpiredPostCleanupTarget>()
      .exec();
  }

  private async cleanupOnePost(
    post: ExpiredPostCleanupTarget,
  ): Promise<boolean> {
    if (!(await this.isEvidenceReleased(post))) return false;
    if (!(await this.reservePhysicalDeletion(post))) return false;
    const imagePublicIds = post.images
      .map((image) => image.publicId)
      .filter(Boolean);

    if (imagePublicIds.length > 0) {
      await this.uploadsService.deleteImages(imagePublicIds, {
        throwOnError: true,
      });
    }

    const deleteResult = await this.postModel
      .deleteOne({
        _id: post._id,
        cleanupStatus: PostCleanupStatus.PROCESSING,
        cleanupLockToken: post.cleanupLockToken,
        cleanupDestructiveStartedAt: { $type: 'date' },
      })
      .exec();

    if (deleteResult.deletedCount !== 1) {
      throw new Error(
        `Expired post cleanup delete skipped for ${post.publicId}`,
      );
    }

    await this.decrementAuthorPostCount(post.authorId, post.publicId);
    return true;
  }

  private async reservePhysicalDeletion(
    post: ExpiredPostCleanupTarget,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.postModel.updateOne(
      {
        _id: post._id,
        cleanupStatus: PostCleanupStatus.PROCESSING,
        cleanupLockToken: post.cleanupLockToken,
        cleanupLockedUntil: { $gt: now },
        $or: [
          { cleanupDestructiveStartedAt: null },
          { cleanupDestructiveStartedAt: { $exists: false } },
        ],
        $and: [
          {
            $or: [
              { evidenceHoldUntil: null },
              { evidenceHoldUntil: { $exists: false } },
              { evidenceHoldUntil: { $lte: now } },
            ],
          },
          {
            $expr: {
              $gte: [
                { $ifNull: ['$moderationNoticeVersion', 0] },
                { $ifNull: ['$moderationVersion', 0] },
              ],
            },
          },
        ],
      },
      {
        $set: {
          cleanupDestructiveStartedAt: now,
          cleanupLockedUntil: new Date(now.getTime() + this.lockMs),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  private async isEvidenceReleased(
    post: ExpiredPostCleanupTarget,
  ): Promise<boolean> {
    if (!this.reportModel || !this.policy) return true;
    const now = new Date();
    const [openReport, heldReport] = await Promise.all([
      this.reportModel.exists({
        targetType: ReportTargetType.POST,
        targetId: post._id,
        status: { $in: [ReportStatus.PENDING, ReportStatus.REVIEWING] },
      }),
      this.reportModel
        .findOne({
          targetType: ReportTargetType.POST,
          targetId: post._id,
          retentionHold: { $ne: null },
          $or: [
            { 'retentionHold.expiresAt': { $gt: now } },
            { 'retentionHold.expiresAt': null },
            { 'retentionHold.expiresAt': { $exists: false } },
          ],
        })
        .sort({ 'retentionHold.expiresAt': -1, _id: 1 })
        .select('+retentionHold')
        .lean<StoredRetentionHold | null>()
        .exec(),
    ]);
    const explicitHoldUntil = heldReport?.retentionHold?.expiresAt;
    const failClosedHoldUntil =
      explicitHoldUntil instanceof Date
        ? explicitHoldUntil
        : heldReport
          ? new Date(now.getTime() + this.lockMs)
          : null;
    if (openReport) {
      await this.deferForEvidence(
        post,
        this.latestDate(
          new Date(now.getTime() + this.lockMs),
          failClosedHoldUntil,
        ),
      );
      return false;
    }

    const latestTerminal = await this.reportModel
      .findOne({
        targetType: ReportTargetType.POST,
        targetId: post._id,
        status: { $in: [ReportStatus.RESOLVED, ReportStatus.REJECTED] },
        terminalAt: { $type: 'date' },
      })
      .sort({ terminalAt: -1 })
      .select('_id terminalAt')
      .lean<{ terminalAt: Date } | null>()
      .exec();
    const graceHoldUntil = latestTerminal
      ? new Date(
          latestTerminal.terminalAt.getTime() +
            this.policy.retention.reportEvidenceGraceDays * 86_400_000,
        )
      : null;
    const holdUntil = this.latestDate(graceHoldUntil, failClosedHoldUntil);
    if (!holdUntil) return true;
    if (holdUntil.getTime() <= now.getTime()) return true;
    await this.deferForEvidence(post, holdUntil);
    return false;
  }

  private latestDate(first: Date | null, second: Date | null): Date | null {
    if (!first) return second;
    if (!second) return first;
    return first.getTime() >= second.getTime() ? first : second;
  }

  private async deferForEvidence(
    post: ExpiredPostCleanupTarget,
    holdUntil: Date | null,
  ): Promise<void> {
    await this.postModel
      .updateOne(
        {
          _id: post._id,
          cleanupStatus: PostCleanupStatus.PROCESSING,
          cleanupLockToken: post.cleanupLockToken,
        },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.PENDING,
            cleanupLockedUntil: null,
            cleanupLockToken: null,
            cleanupLastError: null,
            evidenceHoldUntil: holdUntil,
          },
          $inc: { cleanupAttempts: -1 },
        },
      )
      .exec();
  }

  private async decrementAuthorPostCount(
    authorId: Types.ObjectId,
    postPublicId: string,
  ): Promise<void> {
    try {
      await this.userModel
        .updateOne(
          { _id: authorId, postsCount: { $gt: 0 } },
          { $inc: { postsCount: -1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Failed to decrement postsCount after expired post cleanup. post=${postPublicId}, author=${authorId.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async markCleanupFailed(
    post: ExpiredPostCleanupTarget,
    error: unknown,
  ): Promise<PostCleanupStatus> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(
      `Expired post cleanup failed for post=${post.publicId}: ${message}`,
      error instanceof Error ? error.stack : undefined,
    );

    const manualReview = await this.postModel
      .updateOne(
        {
          _id: post._id,
          cleanupStatus: PostCleanupStatus.PROCESSING,
          cleanupLockToken: post.cleanupLockToken,
          cleanupDestructiveStartedAt: { $type: 'date' },
        },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.MANUAL_REVIEW,
            cleanupLockedUntil: null,
            cleanupLockToken: null,
            cleanupLastError: message.slice(0, 500),
          },
        },
      )
      .exec();
    if (manualReview.modifiedCount === 1) {
      return PostCleanupStatus.MANUAL_REVIEW;
    }

    const failed = await this.postModel
      .updateOne(
        {
          _id: post._id,
          cleanupStatus: PostCleanupStatus.PROCESSING,
          cleanupLockToken: post.cleanupLockToken,
          $or: [
            { cleanupDestructiveStartedAt: null },
            { cleanupDestructiveStartedAt: { $exists: false } },
          ],
        },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.FAILED,
            cleanupLockedUntil: null,
            cleanupLockToken: null,
            cleanupLastError: message.slice(0, 500),
          },
        },
      )
      .exec();
    return failed.modifiedCount === 1
      ? PostCleanupStatus.FAILED
      : PostCleanupStatus.MANUAL_REVIEW;
  }
}
