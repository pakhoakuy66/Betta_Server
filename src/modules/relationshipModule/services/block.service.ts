import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Block } from '../schemas/block.schema';
import { RelationshipService } from './relationship.service';

@Injectable()
export class BlockService {
  constructor(
    @InjectModel(Block.name) private blockModel: Model<Block>,
    // Tiêm RelationshipService vào để mượn lệnh Hủy Follow
    private readonly relationshipService: RelationshipService,
  ) {}

  async blockUser(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new BadRequestException('Bạn không thể tự chặn chính mình');
    }

    const blockerId = new Types.ObjectId(currentUserId);
    const blockedId = new Types.ObjectId(targetUserId);

    const existing = await this.blockModel.findOne({ blockerId, blockedId });
    if (existing) {
      throw new ConflictException('Bạn đã chặn người dùng này rồi');
    }

    // Thực hiện tạo bản ghi chặn
    await this.blockModel.create({ blockerId, blockedId });

    // Ép buộc Hủy Follow 2 chiều (Dùng try-catch để lờ đi lỗi nếu họ vốn dĩ chưa follow nhau)
    try {
      // Chiều 2: Người đó hủy follow tôi (Bị động)
      await this.relationshipService.unfollowUser(currentUserId, targetUserId);
    } catch (e) {
      console.log('No existing relationship to delete, proceeding with block.');
    }

    try {
      // Chiều 2: Người đó hủy follow tôi (Bị động)
      await this.relationshipService.unfollowUser(targetUserId, currentUserId);
    } catch (e) {
      console.log('No existing relationship to delete, proceeding with block.');
    }

    return { success: true, message: 'Đã chặn người dùng thành công' };
  }

  async unblockUser(currentUserId: string, targetUserId: string) {
    // SENIOR CHECK: Kiểm tra dữ liệu đầu vào
    if (!targetUserId || targetUserId === 'undefined') {
      throw new BadRequestException('ID người dùng không hợp lệ');
    }

    try {
      const deleted = await this.blockModel.findOneAndDelete({
        blockerId: new Types.ObjectId(currentUserId),
        blockedId: new Types.ObjectId(targetUserId), // Lỗi xảy ra tại đây nếu targetUserId sai
      });
      if (!deleted)
        throw new BadRequestException('Bạn chưa chặn người dùng này');
      return { success: true, message: 'Đã bỏ chặn người dùng' };
    } catch (error) {
      // Nếu ID không đúng định dạng hex 24 ký tự, Mongoose sẽ throw lỗi BSON
      throw new BadRequestException('Định dạng ID người dùng không hợp lệ');
    }
  }

  async getBlockedUsers(userId: string) {
    const blocks = await this.blockModel
      .find({ blockerId: new Types.ObjectId(userId) })
      .populate(
        'blockedId',
        'publicId username fullname avatar streakCount isDeleted',
      )
      .lean()
      .exec();

    const formattedData = blocks
      .map((b: any) => {
        const user = b.blockedId;
        if (!user) return null;
        if (user.isDeleted) return null;

        return {
          id: user._id.toString(), // Chuyển _id thành id (string)
          publicId: user.publicId,
          username: user.username,
          fullname: user.fullname,
          avatar: user.avatar,
          streakCount: user.streakCount,
        };
      })
      .filter(Boolean); // Loại bỏ các bản ghi lỗi nếu user bị xóa

    return { success: true, data: formattedData };
  }
}
