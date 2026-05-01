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
    const deleted = await this.blockModel.findOneAndDelete({
      blockerId: new Types.ObjectId(currentUserId),
      blockedId: new Types.ObjectId(targetUserId),
    });

    if (!deleted) throw new BadRequestException('Bạn chưa chặn người dùng này');
    return { success: true, message: 'Đã bỏ chặn người dùng' };
  }

  async getBlockedUsers(userId: string) {
    const blocks = await this.blockModel
      .find({ blockerId: new Types.ObjectId(userId) })
      .populate('blockedId', 'username fullname avatar')
      .lean()
      .exec();

    return { success: true, data: blocks.map((b) => b.blockedId) };
  }
}
