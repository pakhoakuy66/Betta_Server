import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';
import { Block } from '../schemas/block.schema';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectModel(Relationship.name)
    private relationshipModel: Model<Relationship>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Block.name) private blockModel: Model<Block>,
  ) {}

  private async getBlockedUserIds(currentUserId?: string) {
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

  async followUser(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new BadRequestException('Bạn không thể tự follow chính mình');
    }

    const targetId = new Types.ObjectId(targetUserId);
    const followerId = new Types.ObjectId(currentUserId);

    const [currentUser, targetUser] = await Promise.all([
      this.userModel.findOne({ _id: followerId, isDeleted: false }),
      this.userModel.findOne({ _id: targetId, isDeleted: false }),
    ]);

    if (!currentUser) {
      throw new BadRequestException(
        'Tài khoản hiện tại không tồn tại hoặc đã bị xóa',
      );
    }

    if (!targetUser) {
      throw new BadRequestException('Người dùng không tồn tại hoặc đã bị xóa');
    }

    const blockRecord = await this.blockModel.findOne({
      $or: [
        { blockerId: followerId, blockedId: targetId },
        { blockerId: targetId, blockedId: followerId },
      ],
    });
    if (blockRecord) {
      throw new BadRequestException(
        'Không thể theo dõi người dùng đang bị chặn hoặc đã chặn bạn',
      );
    }

    // Kiểm tra đã follow chưa
    const existing = await this.relationshipModel.findOne({
      followerId,
      followingId: targetId,
    });
    if (existing) {
      throw new ConflictException('Bạn đã theo dõi người này rồi');
    }

    // 1. Tạo bản ghi quan hệ
    await this.relationshipModel.create({ followerId, followingId: targetId });

    // 2. Tăng bộ đếm cho cả 2 bên cùng lúc (Atomic Operation)
    await Promise.all([
      this.userModel.findByIdAndUpdate(followerId, {
        $inc: { followingCount: 1 },
      }), // Tăng số người mình đang theo dõi
      this.userModel.findByIdAndUpdate(targetId, {
        $inc: { followersCount: 1 },
      }), // Tăng số fan cho Idol
    ]);

    return { success: true, message: 'Đã theo dõi thành công' };
  }

  async unfollowUser(currentUserId: string, targetUserId: string) {
    const targetId = new Types.ObjectId(targetUserId);
    const followerId = new Types.ObjectId(currentUserId);

    const deleted = await this.relationshipModel.findOneAndDelete({
      followerId,
      followingId: targetId,
    });
    if (!deleted) {
      throw new BadRequestException('Bạn chưa theo dõi người này');
    }

    // Giảm bộ đếm (Atomic Operation)
    await Promise.all([
      this.userModel.updateOne(
        { _id: followerId, isDeleted: false, followingCount: { $gt: 0 } },
        { $inc: { followingCount: -1 } },
      ),
      this.userModel.updateOne(
        { _id: targetId, isDeleted: false, followersCount: { $gt: 0 } },
        { $inc: { followersCount: -1 } },
      ),
    ]);

    return { success: true, message: 'Đã bỏ theo dõi thành công' };
  }

  // Lấy danh sách Người theo dõi (Followers)
  async getFollowers(
    userId: string,
    currentUserId?: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;
    const targetUserId = new Types.ObjectId(userId);
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
      { $match: { 'followerUser.isDeleted': false } },
      ...(hiddenUserIds.length > 0
        ? [{ $match: { 'followerUser._id': { $nin: hiddenUserIds } } }]
        : []),
    ];

    const [followers, totalResult] = await Promise.all([
      this.relationshipModel.aggregate([
        ...activeFollowerStages,
        { $sort: { createdAt: -1 } },
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
      this.relationshipModel.aggregate([
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
        id: targetId,
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
    const targetUserId = new Types.ObjectId(userId);
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
      { $match: { 'followingUser.isDeleted': false } },
      ...(hiddenUserIds.length > 0
        ? [{ $match: { 'followingUser._id': { $nin: hiddenUserIds } } }]
        : []),
    ];

    const [following, totalResult] = await Promise.all([
      this.relationshipModel.aggregate([
        ...activeFollowingStages,
        { $sort: { createdAt: -1 } },
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
      this.relationshipModel.aggregate([
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
        id: targetId,
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
