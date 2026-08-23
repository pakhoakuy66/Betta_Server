import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { acquireSocialGraphPairLock } from '../utils/social-graph-lock.util';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';
import { Block } from '../schemas/block.schema';
import { buildEligibleUserMatch } from '../../users/policies/user-eligibility.policy';

const USER_PUBLIC_ID_REGEX = /^usr_[A-Za-z0-9_-]{6,40}$/;

type RelationshipListUser = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar?: string;
  bio?: string;
  streakCount?: number;
};

type CountResult = {
  total: number;
};

type MongoDuplicateKeyError = {
  code?: number;
};

@Injectable()
export class RelationshipService {
  private readonly logger = new Logger(RelationshipService.name);

  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,

    private readonly notificationsService: NotificationsService,
  ) {}

  private async getBlockedUserIds(
    currentUserId?: string,
  ): Promise<Types.ObjectId[]> {
    if (!currentUserId) return [];

    const currentId = new Types.ObjectId(currentUserId);
    const blocks = await this.blockModel
      .find({
        $or: [{ blockerId: currentId }, { blockedId: currentId }],
      })
      .select('blockerId blockedId')
      .lean();

    return blocks.map((block) => {
      const blockerId = block.blockerId.toString();
      return blockerId === currentId.toString()
        ? block.blockedId
        : block.blockerId;
    });
  }

  private buildUserLookupFilter(
    identifier: string,
  ): { _id: Types.ObjectId } | { publicId: string } {
    if (Types.ObjectId.isValid(identifier)) {
      return { _id: new Types.ObjectId(identifier) };
    }

    if (USER_PUBLIC_ID_REGEX.test(identifier)) {
      return { publicId: identifier };
    }

    throw new BadRequestException('Người dùng không hợp lệ');
  }

  private async resolveActiveUserObjectId(
    identifier: string,
    now = new Date(),
  ): Promise<Types.ObjectId> {
    const user = await this.userModel
      .findOne({
        ...this.buildUserLookupFilter(identifier),
        ...buildEligibleUserMatch(now),
      })
      .select('_id')
      .lean()
      .exec();

    if (!user) {
      throw new BadRequestException('Người dùng không tồn tại hoặc đã bị xóa');
    }

    return user._id;
  }

  private toCurrentUserObjectId(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException('Tài khoản hiện tại không hợp lệ');
    }

    return new Types.ObjectId(value);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  private async decrementCounter(
    userId: Types.ObjectId,
    field: 'followersCount' | 'followingCount',
    session: ClientSession,
  ): Promise<void> {
    const result = await this.userModel.updateOne(
      {
        _id: userId,
        isDeleted: false,
      },
      [
        {
          $set: {
            [field]: {
              $max: [
                0,
                {
                  $subtract: [{ $ifNull: [`$${field}`, 0] }, 1],
                },
              ],
            },
          },
        },
      ],
      {
        session,
        updatePipeline: true,
      },
    );

    if (result.matchedCount !== 1) {
      throw new ConflictException(
        'Không thể cập nhật quan hệ người dùng lúc này',
      );
    }
  }

  async followUser(currentUserId: string, targetUserId: string) {
    const followerId = this.toCurrentUserObjectId(currentUserId);
    const targetFilter = this.buildUserLookupFilter(targetUserId);
    const now = new Date();

    const target = await this.userModel
      .findOne({
        ...targetFilter,
        ...buildEligibleUserMatch(now),
      })
      .select('_id')
      .lean()
      .exec();

    if (!target) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const targetId = target._id;

    if (targetId.equals(followerId)) {
      throw new BadRequestException('Bạn không thể tự follow chính mình');
    }

    const session = await this.connection.startSession();

    try {
      await session.withTransaction(async () => {
        await acquireSocialGraphPairLock(
          this.userModel,
          followerId,
          targetId,
          session,
        );

        const currentUserExists = await this.userModel
          .exists({
            _id: followerId,
            ...buildEligibleUserMatch(now),
          })
          .session(session);

        if (!currentUserExists) {
          throw new BadRequestException(
            'Tài khoản hiện tại không thể thực hiện thao tác này',
          );
        }

        const targetExists = await this.userModel
          .exists({
            _id: targetId,
            ...buildEligibleUserMatch(now),
          })
          .session(session);

        if (!targetExists) {
          throw new NotFoundException('Người dùng không tồn tại');
        }

        const blocked = await this.blockModel
          .exists({
            $or: [
              { blockerId: followerId, blockedId: targetId },
              { blockerId: targetId, blockedId: followerId },
            ],
          })
          .session(session);

        if (blocked) {
          throw new NotFoundException('Người dùng không tồn tại');
        }

        const existingRelationship = await this.relationshipModel
          .exists({
            followerId,
            followingId: targetId,
          })
          .session(session);

        if (existingRelationship) {
          throw new ConflictException('Bạn đã theo dõi người này rồi');
        }

        await this.relationshipModel.create(
          [{ followerId, followingId: targetId }],
          { session },
        );

        const followerUpdate = await this.userModel.updateOne(
          {
            _id: followerId,
            ...buildEligibleUserMatch(now),
          },
          { $inc: { followingCount: 1 } },
          { session },
        );

        if (followerUpdate.matchedCount !== 1) {
          throw new ConflictException(
            'Không thể cập nhật trạng thái theo dõi lúc này',
          );
        }

        const targetUpdate = await this.userModel.updateOne(
          {
            _id: targetId,
            ...buildEligibleUserMatch(now),
          },
          { $inc: { followersCount: 1 } },
          { session },
        );

        if (targetUpdate.matchedCount !== 1) {
          throw new ConflictException(
            'Không thể cập nhật trạng thái theo dõi lúc này',
          );
        }
      });

      void this.notificationsService
        .createFollowNotification({
          followerId,
          targetUserId: targetId,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Không thể tạo notification follow. follower=${followerId.toString()}, target=${targetId.toString()}`,
            error instanceof Error ? error.stack : undefined,
          );
        });

      return {
        success: true,
        message: 'Đã theo dõi thành công',
      };
    } catch (error: unknown) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Bạn đã theo dõi người này rồi');
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  async unfollowUser(currentUserId: string, targetUserId: string) {
    const followerId = this.toCurrentUserObjectId(currentUserId);
    const targetFilter = this.buildUserLookupFilter(targetUserId);
    const now = new Date();

    const target = await this.userModel
      .findOne({
        ...targetFilter,
        isDeleted: false,
      })
      .select('_id')
      .lean()
      .exec();

    if (!target) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const targetId = target._id;
    const session = await this.connection.startSession();

    try {
      await session.withTransaction(async () => {
        await acquireSocialGraphPairLock(
          this.userModel,
          followerId,
          targetId,
          session,
        );

        const currentUserExists = await this.userModel
          .exists({
            _id: followerId,
            ...buildEligibleUserMatch(now),
          })
          .session(session);

        if (!currentUserExists) {
          throw new BadRequestException(
            'Tài khoản hiện tại không thể thực hiện thao tác này',
          );
        }

        const deletedRelationship =
          await this.relationshipModel.findOneAndDelete(
            {
              followerId,
              followingId: targetId,
            },
            { session },
          );

        if (!deletedRelationship) {
          throw new BadRequestException('Bạn chưa theo dõi người này');
        }

        await this.decrementCounter(followerId, 'followingCount', session);

        await this.decrementCounter(targetId, 'followersCount', session);
      });

      return {
        success: true,
        message: 'Đã bỏ theo dõi thành công',
      };
    } finally {
      await session.endSession();
    }
  }

  // Lấy danh sách Người theo dõi (Followers)
  async getFollowers(
    userId: string,
    currentUserId?: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;
    const now = new Date();
    const targetUserId = await this.resolveActiveUserObjectId(userId, now);
    const hiddenUserIds = await this.getBlockedUserIds(currentUserId);

    const activeFollowerStages = [
      { $match: { followingId: targetUserId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followerId',
          foreignField: '_id',
          as: 'followerUser',
        },
      },
      { $unwind: '$followerUser' },
      { $match: buildEligibleUserMatch(now, 'followerUser') },
      ...(hiddenUserIds.length > 0
        ? [{ $match: { 'followerUser._id': { $nin: hiddenUserIds } } }]
        : []),
    ];

    const [followers, totalResult] = await Promise.all([
      this.relationshipModel.aggregate<RelationshipListUser>([
        ...activeFollowerStages,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: '$followerUser._id',
            publicId: '$followerUser.publicId',
            username: '$followerUser.username',
            fullname: '$followerUser.fullname',
            avatar: '$followerUser.avatar',
            bio: '$followerUser.bio',
            streakCount: '$followerUser.streakCount',
          },
        },
      ]),
      this.relationshipModel.aggregate<CountResult>([
        ...activeFollowerStages,
        { $count: 'total' },
      ]),
    ]);

    const total = totalResult[0]?.total ?? 0;

    let followingIds: string[] = [];
    if (currentUserId) {
      const myFollowing = await this.relationshipModel
        .find({
          followerId: new Types.ObjectId(currentUserId),
          followingId: {
            $in: followers.map((f) => f._id),
          },
        })
        .select('followingId')
        .lean();

      followingIds = myFollowing.map((f) => f.followingId.toString());
    }

    const formattedData = followers.map((user) => {
      const targetId = user._id.toString();

      return {
        id: user.publicId,
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
        streakCount: user.streakCount,
        isFollowing: followingIds.includes(targetId),
      };
    });

    return {
      success: true,
      data: formattedData,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // Lấy danh sách người được theo dõi (Following)
  async getFollowing(
    userId: string,
    currentUserId?: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;
    const now = new Date();
    const targetUserId = await this.resolveActiveUserObjectId(userId, now);
    const hiddenUserIds = await this.getBlockedUserIds(currentUserId);

    const activeFollowingStages = [
      { $match: { followerId: targetUserId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followingId',
          foreignField: '_id',
          as: 'followingUser',
        },
      },
      { $unwind: '$followingUser' },
      { $match: buildEligibleUserMatch(now, 'followingUser') },
      ...(hiddenUserIds.length > 0
        ? [{ $match: { 'followingUser._id': { $nin: hiddenUserIds } } }]
        : []),
    ];

    const [following, totalResult] = await Promise.all([
      this.relationshipModel.aggregate<RelationshipListUser>([
        ...activeFollowingStages,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: '$followingUser._id',
            publicId: '$followingUser.publicId',
            username: '$followingUser.username',
            fullname: '$followingUser.fullname',
            avatar: '$followingUser.avatar',
            bio: '$followingUser.bio',
            streakCount: '$followingUser.streakCount',
          },
        },
      ]),
      this.relationshipModel.aggregate<CountResult>([
        ...activeFollowingStages,
        { $count: 'total' },
      ]),
    ]);

    const total = totalResult[0]?.total ?? 0;

    let followingIds: string[] = [];
    if (currentUserId) {
      const myFollowing = await this.relationshipModel
        .find({
          followerId: new Types.ObjectId(currentUserId),
          followingId: {
            $in: following.map((f) => f._id),
          },
        })
        .select('followingId')
        .lean();

      followingIds = myFollowing.map((f) => f.followingId.toString());
    }

    const formattedData = following.map((user) => {
      const targetId = user._id.toString();

      return {
        id: user.publicId,
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
        streakCount: user.streakCount,
        isFollowing: followingIds.includes(targetId),
      };
    });

    return {
      success: true,
      data: formattedData,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }
}
