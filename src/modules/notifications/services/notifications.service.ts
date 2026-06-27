import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import {
  Notification,
  NotificationType,
  NOTIFICATION_TTL_MS,
} from '../schemas/notifications.schema';

const MAX_VISIBLE_NOTIFICATION_ACTORS = 3;

const NOTIFICATION_CONTENT = {
  FOLLOW: 'đã bắt đầu theo dõi bạn',
  REACTION: 'đã thả tim bài viết của bạn',
} as const;

type MongoDuplicateKeyError = {
  code?: number;
};

type CreateFollowNotificationInput = {
  followerId: Types.ObjectId;
  targetUserId: Types.ObjectId;
};

type CreateReactionNotificationInput = {
  actorId: Types.ObjectId;
  postOwnerId: Types.ObjectId;
  postId: Types.ObjectId;
  postPublicId: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
  ) {}

  async createFollowNotification({
    followerId,
    targetUserId,
  }: CreateFollowNotificationInput): Promise<void> {
    if (followerId.equals(targetUserId)) return;

    const now = new Date();
    const dedupeKey = `follow:${targetUserId.toString()}:${followerId.toString()}`;

    try {
      await this.upsertFollowNotification({
        followerId,
        targetUserId,
        dedupeKey,
        now,
        upsert: true,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        try {
          await this.upsertFollowNotification({
            followerId,
            targetUserId,
            dedupeKey,
            now,
            upsert: false,
          });
          return;
        } catch (retryError) {
          this.logFollowNotificationError(followerId, targetUserId, retryError);
          return;
        }
      }

      this.logFollowNotificationError(followerId, targetUserId, error);
    }
  }

  async createReactionNotification({
    actorId,
    postOwnerId,
    postId,
    postPublicId,
  }: CreateReactionNotificationInput): Promise<void> {
    if (actorId.equals(postOwnerId)) return;

    const now = new Date();
    const dedupeKey = `reaction:${postOwnerId.toString()}:${postId.toString()}`;

    try {
      await this.upsertReactionNotification({
        actorId,
        postOwnerId,
        postId,
        postPublicId,
        dedupeKey,
        now,
        upsert: true,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        try {
          await this.upsertReactionNotification({
            actorId,
            postOwnerId,
            postId,
            postPublicId,
            dedupeKey,
            now,
            upsert: false,
          });
          return;
        } catch (retryError) {
          this.logReactionNotificationError(actorId, postPublicId, retryError);
          return;
        }
      }

      this.logReactionNotificationError(actorId, postPublicId, error);
    }
  }

  private async upsertFollowNotification({
    followerId,
    targetUserId,
    dedupeKey,
    now,
    upsert,
  }: {
    followerId: Types.ObjectId;
    targetUserId: Types.ObjectId;
    dedupeKey: string;
    now: Date;
    upsert: boolean;
  }): Promise<void> {
    await this.notificationModel
      .findOneAndUpdate(
        { dedupeKey },
        {
          $set: {
            recipientId: targetUserId,
            type: NotificationType.FOLLOW,
            actorIds: [followerId],
            countedActorIds: [followerId],
            actorCount: 1,
            otherCount: 0,
            content: NOTIFICATION_CONTENT.FOLLOW,
            targetId: followerId,
            dedupeKey,
            isRead: false,
            expiresAt: this.buildExpiryDate(now),
          },
        },
        {
          upsert,
          returnDocument: 'after',
        },
      )
      .exec();
  }

  private async upsertReactionNotification({
    actorId,
    postOwnerId,
    postId,
    postPublicId,
    dedupeKey,
    now,
    upsert,
  }: {
    actorId: Types.ObjectId;
    postOwnerId: Types.ObjectId;
    postId: Types.ObjectId;
    postPublicId: string;
    dedupeKey: string;
    now: Date;
    upsert: boolean;
  }): Promise<void> {
    await this.notificationModel
      .findOneAndUpdate(
        { dedupeKey },
        this.buildReactionNotificationPipeline({
          actorId,
          postOwnerId,
          postId,
          postPublicId,
          dedupeKey,
          now,
        }),
        {
          upsert,
          returnDocument: 'after',
          updatePipeline: true,
        },
      )
      .exec();
  }

  private buildReactionNotificationPipeline({
    actorId,
    postOwnerId,
    postId,
    postPublicId,
    dedupeKey,
    now,
  }: {
    actorId: Types.ObjectId;
    postOwnerId: Types.ObjectId;
    postId: Types.ObjectId;
    postPublicId: string;
    dedupeKey: string;
    now: Date;
  }): PipelineStage[] {
    const expiresAt = this.buildExpiryDate(now);

    return [
      {
        $set: {
          recipientId: postOwnerId,
          type: NotificationType.REACTION,
          content: NOTIFICATION_CONTENT.REACTION,
          targetId: postId,
          targetPublicId: postPublicId,
          dedupeKey,
          isRead: false,
          expiresAt,
          _currentActorIds: { $ifNull: ['$actorIds', []] },
          _currentCountedActorIds: { $ifNull: ['$countedActorIds', []] },
        },
      },
      {
        $set: {
          _actorAlreadyVisible: {
            $in: [actorId, '$_currentActorIds'],
          },
          _actorAlreadyCounted: {
            $in: [actorId, '$_currentCountedActorIds'],
          },
        },
      },
      {
        $set: {
          countedActorIds: {
            $cond: [
              '$_actorAlreadyCounted',
              '$_currentCountedActorIds',
              {
                $concatArrays: [[actorId], '$_currentCountedActorIds'],
              },
            ],
          },
          actorIds: {
            $cond: [
              '$_actorAlreadyVisible',
              '$_currentActorIds',
              {
                $slice: [
                  {
                    $concatArrays: [[actorId], '$_currentActorIds'],
                  },
                  MAX_VISIBLE_NOTIFICATION_ACTORS,
                ],
              },
            ],
          },
        },
      },
      {
        $set: {
          actorCount: {
            $size: '$countedActorIds',
          },
        },
      },
      {
        $set: {
          otherCount: {
            $max: [
              0,
              {
                $subtract: ['$actorCount', MAX_VISIBLE_NOTIFICATION_ACTORS],
              },
            ],
          },
        },
      },
      {
        $unset: [
          '_currentActorIds',
          '_currentCountedActorIds',
          '_actorAlreadyVisible',
          '_actorAlreadyCounted',
        ],
      },
    ];
  }

  private buildExpiryDate(from: Date): Date {
    return new Date(from.getTime() + NOTIFICATION_TTL_MS);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  private logFollowNotificationError(
    followerId: Types.ObjectId,
    targetUserId: Types.ObjectId,
    error: unknown,
  ): void {
    this.logger.warn(
      `[NOTIFICATION_FOLLOW_CREATE_FAILED] follower=${followerId.toString()} target=${targetUserId.toString()}`,
      error instanceof Error ? error.stack : String(error),
    );
  }

  private logReactionNotificationError(
    actorId: Types.ObjectId,
    postPublicId: string,
    error: unknown,
  ): void {
    this.logger.warn(
      `[NOTIFICATION_REACTION_CREATE_FAILED] actor=${actorId.toString()} post=${postPublicId}`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
