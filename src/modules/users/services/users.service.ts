import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User } from '../schemas/user.schema';
import { UpdateProfileDto } from '../dto/users.dto';
import { UserProfileResponse } from '../interfaces/users.interface';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
  ) {}

  // Lấy Profile theo Username (Dành cho việc người khác vào xem tường nhà)
  async getProfileByUsername(
    username: string,
    currentUserId?: string,
  ): Promise<{ success: boolean; data: UserProfileResponse }> {
    const user = await this.userModel
      .findOne({ username, isDeleted: false })
      .select(
        '-password -forgotPasswordOtp -forgotPasswordExpiry -refreshToken -isDeleted -deletedAt',
      ) // Ẩn triệt để thông tin mật
      .lean()
      .exec();

    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng này');
    }

    let isFollowing = false;

    if (currentUserId) {
      const currentId = new Types.ObjectId(currentUserId);
      const targetId = user._id;
      // KIỂM TRA CHẶN 2 CHIỀU
      const blockRecord = await this.blockModel.findOne({
        $or: [
          { blockerId: currentId, blockedId: targetId },
          { blockerId: targetId, blockedId: currentId },
        ],
      });

      if (blockRecord) {
        throw new NotFoundException('Không tìm thấy người dùng này');
      }
      // Kiểm tra follow (Chỉ chạy khi không bị chặn)
      const followRecord = await this.relationshipModel.findOne({
        followerId: currentId,
        followingId: targetId,
      });
      isFollowing = !!followRecord;
    }

    const [realFollowersCount, realFollowingCount] = await Promise.all([
      this.countActiveFollowers(user._id),
      this.countActiveFollowing(user._id),
    ]);

    // Nếu không bị chặn, trả về Full Profile (Map _id thành id)
    const { _id, ...rest } = user;
    return {
      success: true,
      data: {
        id: _id.toString(),
        publicId: rest.publicId,
        isFollowing,
        isBlocked: false,
        ...rest,
        followersCount: realFollowersCount,
        followingCount: realFollowingCount,
      } as UserProfileResponse,
    };
  }

  // Cập nhật thông tin cá nhân (Dành cho chính chủ)
  async updateProfile(userId: string, updateData: UpdateProfileDto) {
    // Tách riêng các trường cho phép sửa
    const allowedUpdates = { ...updateData };

    const updatedUser = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $set: allowedUpdates },
        { new: true, runValidators: true },
      )
      .select('-password -refreshToken')
      .lean()
      .exec();

    if (!updatedUser) {
      throw new BadRequestException('Không thể cập nhật hồ sơ');
    }

    const { _id, ...rest } = updatedUser;
    return {
      success: true,
      message: 'Cập nhật hồ sơ thành công',
      data: { id: _id.toString(), ...rest }, // Map lại _id thành id
    };
  }

  // Trong UsersService (Chuyển đổi trạng thái thay vì xóa hẳn)
  async softDeleteUser(userId: string) {
    const uid = new Types.ObjectId(userId);

    // 1. Kiểm tra xem user có tồn tại và đã bị xóa trước đó chưa
    const user = await this.userModel.findOne({ _id: uid, isDeleted: false });
    if (!user) {
      throw new NotFoundException(
        'Không tìm thấy người dùng hoặc tài khoản đã bị xóa trước đó',
      );
    }

    // 2. Lấy danh sách những người mà user này đang follow
    const followings = await this.relationshipModel
      .find({ followerId: uid })
      .lean();
    const followingIds = followings.map((rel) => rel.followingId);

    // 3. Lấy danh sách những người đang follow user này
    const followers = await this.relationshipModel
      .find({ followingId: uid })
      .lean();
    const followerIds = followers.map((rel) => rel.followerId);

    // 4. TỰ ĐỘNG CẬP NHẬT: Giảm bộ đếm của những người liên quan
    await Promise.all([
      // Trừ 1 followersCount của tất cả những người mà user này từng follow
      this.userModel.updateMany(
        { _id: { $in: followingIds } },
        { $inc: { followersCount: -1 } },
      ),
      // Trừ 1 followingCount của tất cả những fan đang follow user này
      this.userModel.updateMany(
        { _id: { $in: followerIds } },
        { $inc: { followingCount: -1 } },
      ),
    ]);

    // 5. Cập nhật trạng thái Xóa mềm (Soft Delete) cho chính chủ
    await this.userModel.findByIdAndUpdate(uid, {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        status: 'banned',
        followersCount: 0, // Reset luôn bộ đếm của tài khoản bị xóa về 0
        followingCount: 0, // Reset luôn bộ đếm của tài khoản bị xóa về 0
      },
    });

    return {
      success: true,
      message:
        'Đã ẩn tài khoản và tự động cập nhật lại bộ đếm hệ thống thành công!',
    };
  }

  private async countActiveFollowers(userId: Types.ObjectId) {
    const result = await this.relationshipModel.aggregate([
      { $match: { followingId: userId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followerId',
          foreignField: '_id',
          as: 'follower',
        },
      },
      { $unwind: '$follower' },
      { $match: { 'follower.isDeleted': false } },
      { $count: 'total' },
    ]);

    return result[0]?.total ?? 0;
  }

  private async countActiveFollowing(userId: Types.ObjectId) {
    const result = await this.relationshipModel.aggregate([
      { $match: { followerId: userId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followingId',
          foreignField: '_id',
          as: 'following',
        },
      },
      { $unwind: '$following' },
      { $match: { 'following.isDeleted': false } },
      { $count: 'total' },
    ]);

    return result[0]?.total ?? 0;
  }
}
