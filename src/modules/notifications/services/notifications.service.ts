import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import {
  Notification,
  NotificationType,
  NOTIFICATION_TTL_MS,
} from '../schemas/notifications.schema';
import { User } from '../../users/schemas/user.schema';
import { NotificationsQueryDto } from '../dto/notifications-query.dto';

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

type NotificationActorResponse = {
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
};

type NotificationResponse = {
  id: string;
  type: NotificationType;
  actors: NotificationActorResponse[];
  actorCount: number;
  otherCount: number;
  content: string;
  targetId?: string;
  targetPublicId?: string;
  isRead: boolean;
  createdAt: Date;
};

type NotificationLeanDocument = {
  _id: Types.ObjectId;
  type: NotificationType;
  actorIds: Types.ObjectId[];
  actorCount: number;
  otherCount: number;
  content: string;
  targetId?: Types.ObjectId;
  targetPublicId?: string;
  isRead: boolean;
  createdAt: Date;
};

type ActorLeanDocument = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
};

type NotificationListFilter = {
  recipientId: Types.ObjectId;
  isRead?: boolean;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async getNotifications(userId: string, query: NotificationsQueryDto) {
    const userObjectId = this.toObjectId(userId);
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const filter: NotificationListFilter = {
      recipientId: userObjectId,
    };

    if (query.unreadOnly === true) {
      filter.isRead = false;
    }

    const [notifications, unreadCount] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1)
        .select(
          '_id type actorIds actorCount otherCount content targetId targetPublicId isRead createdAt',
        )
        .lean<NotificationLeanDocument[]>()
        .exec(),

      this.notificationModel
        .countDocuments({
          recipientId: userObjectId,
          isRead: false,
        })
        .exec(),
    ]);

    const hasMore = notifications.length > limit;
    const pageNotifications = notifications.slice(0, limit);
    const actorMap = await this.getActorMap(pageNotifications);

    return {
      success: true,
      data: pageNotifications.map((notification) =>
        this.toNotificationResponse(notification, actorMap),
      ),
      pagination: {
        page,
        limit,
        hasMore,
      },
      unreadCount,
    };
  }

  async getUnreadCount(userId: string) {
    const userObjectId = this.toObjectId(userId);

    const unreadCount = await this.notificationModel
      .countDocuments({
        recipientId: userObjectId,
        isRead: false,
      })
      .exec();

    return {
      success: true,
      data: {
        unreadCount,
      },
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    const userObjectId = this.toObjectId(userId);
    const notificationObjectId = this.toObjectId(notificationId);

    const updateResult = await this.notificationModel
      .updateOne(
        {
          _id: notificationObjectId,
          recipientId: userObjectId,
          isRead: false,
        },
        {
          $set: {
            isRead: true,
          },
        },
      )
      .exec();

    if (updateResult.modifiedCount === 1) {
      return {
        success: true,
        message: 'Đã đánh dấu thông báo là đã đọc',
        data: {
          modifiedCount: 1,
        },
      };
    }

    const existingNotification = await this.notificationModel
      .findOne({
        _id: notificationObjectId,
        recipientId: userObjectId,
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }>()
      .exec();

    if (!existingNotification) {
      throw new NotFoundException('Thông báo không tồn tại');
    }

    return {
      success: true,
      message: 'Thông báo đã được đọc trước đó',
      data: {
        modifiedCount: 0,
      },
    };
  }

  async markAllAsRead(userId: string) {
    const userObjectId = this.toObjectId(userId);

    const result = await this.notificationModel
      .updateMany(
        {
          recipientId: userObjectId,
          isRead: false,
        },
        {
          $set: {
            isRead: true,
          },
        },
      )
      .exec();

    return {
      success: true,
      message: 'Đã đánh dấu tất cả thông báo là đã đọc',
      data: {
        modifiedCount: result.modifiedCount,
      },
    };
  }

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
          createdAt: { $ifNull: ['$createdAt', now] },
          updatedAt: now,
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

  private async getActorMap(
    notifications: NotificationLeanDocument[],
  ): Promise<Map<string, NotificationActorResponse>> {
    const actorIds = [
      ...new Set(
        notifications.flatMap((notification) =>
          notification.actorIds.map((actorId) => actorId.toString()),
        ),
      ),
    ];

    if (actorIds.length === 0) {
      return new Map();
    }

    const actors = await this.userModel
      .find({
        _id: {
          $in: actorIds.map((id) => new Types.ObjectId(id)),
        },
        isDeleted: false,
        status: 'active',
      })
      .select('_id publicId username fullname avatar')
      .lean<ActorLeanDocument[]>()
      .exec();

    return new Map(
      actors.map((actor) => [
        actor._id.toString(),
        {
          id: actor._id.toString(),
          publicId: actor.publicId,
          username: actor.username,
          fullname: actor.fullname,
          avatar: actor.avatar,
        },
      ]),
    );
  }

  private toNotificationResponse(
    notification: NotificationLeanDocument,
    actorMap: Map<string, NotificationActorResponse>,
  ): NotificationResponse {
    const actors = notification.actorIds
      .map((actorId) => actorMap.get(actorId.toString()))
      .filter((actor): actor is NotificationActorResponse => Boolean(actor));

    return {
      id: notification._id.toString(),
      type: notification.type,
      actors,
      actorCount: notification.actorCount,
      otherCount: notification.otherCount,
      content: notification.content,
      targetId: notification.targetId?.toString(),
      targetPublicId: notification.targetPublicId,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    };
  }

  private toObjectId(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException('ID không hợp lệ');
    }

    return new Types.ObjectId(value);
  }
}
