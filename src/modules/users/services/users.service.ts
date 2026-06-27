import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  User,
} from '../schemas/user.schema';
import { SearchUsersQueryDto, UpdateProfileDto } from '../dto/users.dto';
import { UserProfileResponse } from '../interfaces/users.interface';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { UploadsService } from '../../uploads/services/uploads.service';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type CountResult = {
  total: number;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    private readonly uploadsService: UploadsService,
  ) {}

  // Search
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async getHiddenUserIdsForSearch(currentUserId: string) {
    const currentObjectId = new Types.ObjectId(currentUserId);

    const blocks = await this.blockModel
      .find({
        $or: [{ blockerId: currentObjectId }, { blockedId: currentObjectId }],
      })
      .select('blockerId blockedId')
      .lean()
      .exec();

    const blockedUserIds = blocks.map((block) => {
      const blockerId = block.blockerId.toString();

      return blockerId === currentObjectId.toString()
        ? block.blockedId
        : block.blockerId;
    });

    return [currentObjectId, ...blockedUserIds];
  }

  async searchUsers(currentUserId: string, query: SearchUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const keyword = query.q.trim();
    const escapedKeyword = this.escapeRegExp(keyword);
    const hiddenUserIds = await this.getHiddenUserIdsForSearch(currentUserId);

    const filter = {
      isDeleted: false,
      status: 'active',
      username: {
        $regex: escapedKeyword,
        $options: 'i',
      },
      _id: {
        $nin: hiddenUserIds,
      },
    };

    const users = await this.userModel
      .find(filter)
      .select('publicId username fullname avatar bio streakCount')
      .sort({ username: 1, _id: 1 })
      .collation({ locale: 'en', strength: 2 })
      .skip(skip)
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = users.length > limit;
    const items = hasMore ? users.slice(0, limit) : users;

    return {
      success: true,
      data: items.map((user) => ({
        id: user._id.toString(),
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
        streakCount: user.streakCount,
      })),
      pagination: {
        page,
        limit,
        hasMore,
      },
    };
  }

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
    const { _id, avatarId, ...rest } = user;

    return {
      success: true,
      data: {
        id: _id.toString(),
        isFollowing,
        isBlocked: false,
        ...rest,
        hasCustomAvatar: avatarId !== DEFAULT_AVATAR_ID,
        followersCount: realFollowersCount,
        followingCount: realFollowingCount,
      },
    };
  }

  private buildUpdateProfilePayload(updateData: UpdateProfileDto) {
    const payload: Partial<Pick<User, 'username' | 'bio' | 'link'>> = {};

    if (updateData.username !== undefined) {
      payload.username = updateData.username;
    }

    if (updateData.bio !== undefined) {
      payload.bio = updateData.bio;
    }

    if (updateData.link !== undefined) {
      payload.link = updateData.link;
    }

    return payload;
  }

  // Cập nhật thông tin cá nhân (Dành cho chính chủ)
  async updateProfile(userId: string, updateData: UpdateProfileDto) {
    const allowedUpdates = this.buildUpdateProfilePayload(updateData);

    if (Object.keys(allowedUpdates).length === 0) {
      throw new BadRequestException('Không có dữ liệu hợp lệ để cập nhật');
    }

    const userObjectId = new Types.ObjectId(userId);

    if (allowedUpdates.username !== undefined) {
      const duplicateUsername = await this.userModel
        .findOne({
          _id: { $ne: userObjectId },
          username: allowedUpdates.username,
          isDeleted: false,
        })
        .select('_id')
        .lean()
        .exec();

      if (duplicateUsername) {
        throw new ConflictException('Username đã được sử dụng');
      }
    }

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        { $set: allowedUpdates },
        { new: true, runValidators: true },
      )
      .select(
        '-password -refreshToken -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!updatedUser) {
      throw new BadRequestException('Không thể cập nhật hồ sơ');
    }

    const { _id, avatarId, ...rest } = updatedUser;

    return {
      success: true,
      message: 'Cập nhật hồ sơ thành công',
      data: {
        id: _id.toString(),
        ...rest,
        hasCustomAvatar: avatarId !== DEFAULT_AVATAR_ID,
      },
    };
  }

  async updateAvatar(userId: string, file?: UploadFile) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn ảnh avatar');
    }

    const userObjectId = new Types.ObjectId(userId);

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select('_id avatarId')
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Không tìm thấy tài khoản hợp lệ');
    }

    const uploadedAvatar = await this.uploadsService.uploadAvatar(file);

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            avatar: uploadedAvatar.url,
            avatarId: uploadedAvatar.publicId,
          },
        },
        { new: true, runValidators: true },
      )
      .select(
        '-password -refreshToken -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec()
      .catch(async (error: unknown) => {
        await this.uploadsService.deleteImage(uploadedAvatar.publicId);
        throw error;
      });

    if (!updatedUser) {
      await this.uploadsService.deleteImage(uploadedAvatar.publicId);
      throw new BadRequestException('Không thể cập nhật avatar');
    }

    const oldAvatarId = currentUser.avatarId;

    if (oldAvatarId && oldAvatarId !== DEFAULT_AVATAR_ID) {
      try {
        await this.uploadsService.deleteImage(oldAvatarId);
      } catch (cleanupError: unknown) {
        this.logger.warn(
          `[AVATAR_CLEANUP_FAILED] Failed to delete old avatar ${oldAvatarId}: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }

    const { _id, avatarId, ...rest } = updatedUser;

    return {
      success: true,
      message: 'Cập nhật avatar thành công',
      data: {
        id: _id.toString(),
        ...rest,
        hasCustomAvatar: avatarId !== DEFAULT_AVATAR_ID,
      },
    };
  }

  async removeAvatar(userId: string) {
    const userObjectId = new Types.ObjectId(userId);

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select(
        '-password -refreshToken -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Không tìm thấy tài khoản hợp lệ');
    }

    if (currentUser.avatarId === DEFAULT_AVATAR_ID) {
      const { _id, avatarId, ...rest } = currentUser;

      return {
        success: true,
        message: 'Avatar đang là ảnh mặc định',
        data: {
          id: _id.toString(),
          ...rest,
          hasCustomAvatar: avatarId !== DEFAULT_AVATAR_ID,
        },
      };
    }

    const oldAvatarId = currentUser.avatarId;

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            avatar: DEFAULT_AVATAR_URL,
            avatarId: DEFAULT_AVATAR_ID,
          },
        },
        { new: true, runValidators: true },
      )
      .select(
        '-password -refreshToken -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!updatedUser) {
      throw new BadRequestException('Không thể xóa avatar');
    }

    if (oldAvatarId) {
      try {
        await this.uploadsService.deleteImage(oldAvatarId);
      } catch (cleanupError: unknown) {
        this.logger.warn(
          `[AVATAR_CLEANUP_FAILED] Failed to delete avatar ${oldAvatarId}: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }

    const { _id, avatarId, ...rest } = updatedUser;

    return {
      success: true,
      message: 'Đã xóa avatar',
      data: {
        id: _id.toString(),
        ...rest,
        hasCustomAvatar: avatarId !== DEFAULT_AVATAR_ID,
      },
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
        refreshToken: null, // null vì field này vẫn cần tồn tại để check
        followersCount: 0, // Reset luôn bộ đếm của tài khoản bị xóa về 0
        followingCount: 0, // Reset luôn bộ đếm của tài khoản bị xóa về 0
      },
      $unset: {
        forgotPasswordOtp: '',
        forgotPasswordExpiry: '', // xóa hẳn vì không cần giữ field
      },
    });

    return {
      success: true,
      message:
        'Đã ẩn tài khoản và tự động cập nhật lại bộ đếm hệ thống thành công!',
    };
  }

  private async countActiveFollowers(userId: Types.ObjectId): Promise<number> {
    const result = await this.relationshipModel.aggregate<CountResult>([
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

  private async countActiveFollowing(userId: Types.ObjectId): Promise<number> {
    const result = await this.relationshipModel.aggregate<CountResult>([
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
