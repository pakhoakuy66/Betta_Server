import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectModel(Relationship.name)
    private relationshipModel: Model<Relationship>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

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

    const followers = await this.relationshipModel
      .find({ followingId: targetUserId })
      .populate({
        path: 'followerId',
        match: { isDeleted: false },
        select: 'username fullname avatar bio streakCount isDeleted',
      })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const validFollowers = followers.filter((rel) => {
      const userObj: any = rel.followerId;
      return userObj && userObj._id;
    });

    const totalResult = await this.relationshipModel.aggregate([
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
      { $count: 'total' },
    ]);

    const total = totalResult[0]?.total ?? 0;

    let followingIds: string[] = [];
    if (currentUserId) {
      const myFollowing = await this.relationshipModel
        .find({
          followerId: new Types.ObjectId(currentUserId),
          followingId: {
            $in: validFollowers.map((f) => (f.followerId as any)._id),
          },
        })
        .select('followingId')
        .lean();

      followingIds = myFollowing.map((f) => f.followingId.toString());
    }

    const formattedData = validFollowers.map((rel) => {
      const userObj: any = rel.followerId;
      const targetId = userObj._id.toString();

      return {
        id: targetId,
        username: userObj.username,
        fullname: userObj.fullname,
        avatar: userObj.avatar,
        bio: userObj.bio,
        streakCount: userObj.streakCount,
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

    const following = await this.relationshipModel
      .find({ followerId: targetUserId })
      .populate({
        path: 'followingId',
        match: { isDeleted: false },
        select: 'username fullname avatar bio streakCount isDeleted',
      })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const validFollowing = following.filter((rel) => {
      const userObj: any = rel.followingId;
      return userObj && userObj._id;
    });

    const totalResult = await this.relationshipModel.aggregate([
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
      { $count: 'total' },
    ]);

    const total = totalResult[0]?.total ?? 0;

    let followingIds: string[] = [];
    if (currentUserId) {
      const myFollowing = await this.relationshipModel
        .find({
          followerId: new Types.ObjectId(currentUserId),
          followingId: {
            $in: validFollowing.map((f) => (f.followingId as any)._id),
          },
        })
        .select('followingId')
        .lean();

      followingIds = myFollowing.map((f) => f.followingId.toString());
    }

    const formattedData = validFollowing.map((rel) => {
      const userObj: any = rel.followingId;
      const targetId = userObj._id.toString();

      return {
        id: targetId,
        username: userObj.username,
        fullname: userObj.fullname,
        avatar: userObj.avatar,
        bio: userObj.bio,
        streakCount: userObj.streakCount,
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
