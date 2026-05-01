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

    // Nếu không bị chặn, trả về Full Profile (Map _id thành id)
    const { _id, ...rest } = user;
    return {
      success: true,
      data: {
        id: _id.toString(),
        isFollowing,
        isBlocked: false,
        ...rest,
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
}
