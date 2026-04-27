import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectModel(Relationship.name) private relationshipModel: Model<Relationship>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  async followUser(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new BadRequestException('Bạn không thể tự follow chính mình');
    }

    const targetId = new Types.ObjectId(targetUserId);
    const followerId = new Types.ObjectId(currentUserId);

    // Kiểm tra đã follow chưa
    const existing = await this.relationshipModel.findOne({ followerId, followingId: targetId });
    if (existing) {
      throw new ConflictException('Bạn đã theo dõi người này rồi');
    }

    // 1. Tạo bản ghi quan hệ
    await this.relationshipModel.create({ followerId, followingId: targetId });

    // 2. Tăng bộ đếm cho cả 2 bên cùng lúc (Atomic Operation)
    await Promise.all([
      this.userModel.findByIdAndUpdate(followerId, { $inc: { followingCount: 1 } }), // Tăng số người mình đang theo dõi
      this.userModel.findByIdAndUpdate(targetId, { $inc: { followersCount: 1 } })    // Tăng số fan cho Idol
    ]);

    return { success: true, message: 'Đã theo dõi thành công' };
  }

  async unfollowUser(currentUserId: string, targetUserId: string) {
    const targetId = new Types.ObjectId(targetUserId);
    const followerId = new Types.ObjectId(currentUserId);

    const deleted = await this.relationshipModel.findOneAndDelete({ followerId, followingId: targetId });
    if (!deleted) {
      throw new BadRequestException('Bạn chưa theo dõi người này');
    }

    // Giảm bộ đếm (Atomic Operation)
    await Promise.all([
      this.userModel.findByIdAndUpdate(followerId, { $inc: { followingCount: -1 } }),
      this.userModel.findByIdAndUpdate(targetId, { $inc: { followersCount: -1 } })
    ]);

    return { success: true, message: 'Đã bỏ theo dõi thành công' };
  }

    // Lấy danh sách Người theo dõi (Followers)
  async getFollowers(userId: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;
    
    // Tìm tất cả bản ghi có followingId là mình, sau đó "populate" lôi thông tin của người follow ra
    const followers = await this.relationshipModel
      .find({ followingId: new Types.ObjectId(userId) })
      .populate('followerId', 'username fullname avatar bio streakCount') // Chỉ lấy các trường cần thiết, bỏ password đi
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const total = await this.relationshipModel.countDocuments({ followingId: new Types.ObjectId(userId) });

    const formattedData = followers.map(rel => {
      const userObj: any = rel.followerId;
      return {
        id: userObj._id.toString(),
        username: userObj.username,
        fullname: userObj.fullname,
        avatar: userObj.avatar,
        bio: userObj.bio,
        streakCount: userObj.streakCount
      };
    });

    return {
      success: true,
      data: formattedData,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };
  }

  // Lấy danh sách người được theo dõi (Following)
  async getFollowing(userId: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;
    
    const following = await this.relationshipModel
      .find({ followerId: new Types.ObjectId(userId) })
      .populate('followingId', 'username fullname avatar bio streakCount')
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const total = await this.relationshipModel.countDocuments({ followerId: new Types.ObjectId(userId) });

        const formattedData = following.map(rel => {
      const userObj: any = rel.followingId;
      return {
        id: userObj._id.toString(),
        username: userObj.username,
        fullname: userObj.fullname,
        avatar: userObj.avatar,
        bio: userObj.bio,
        streakCount: userObj.streakCount
      };
    });

    return {
      success: true,
      data: formattedData,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };

  }

}
