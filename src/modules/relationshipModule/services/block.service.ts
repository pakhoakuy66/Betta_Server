import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Block } from '../schemas/block.schema';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';

type MongoDuplicateKeyError = {
  code?: number;
};

type PopulatedBlockedUser = {
  _id: Types.ObjectId;
  publicId?: string;
  username: string;
  fullname: string;
  avatar?: string;
  streakCount?: number;
  isDeleted?: boolean;
};

@Injectable()
export class BlockService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,

    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  private toObjectId(id: string, message: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(message);
    }

    return new Types.ObjectId(id);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  async blockUser(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new BadRequestException('Bạn không thể tự chặn chính mình');
    }

    const blockerId = this.toObjectId(
      currentUserId,
      'ID người dùng hiện tại không hợp lệ',
    );
    const blockedId = this.toObjectId(
      targetUserId,
      'ID người dùng cần chặn không hợp lệ',
    );

    const session = await this.connection.startSession();

    try {
      /*
       * Transaction đảm bảo block record, relationship cleanup và counter update
       * cùng commit/rollback. Business exceptions sẽ bubble ra ngoài, không retry
       * như lỗi transient của MongoDB.
       */
      await session.withTransaction(async () => {
        const [targetUser, existingBlock] = await Promise.all([
          this.userModel
            .findOne({
              _id: blockedId,
              isDeleted: false,
              status: 'active',
            })
            .select('_id')
            .session(session)
            .lean()
            .exec(),

          this.blockModel
            .findOne({
              blockerId,
              blockedId,
            })
            .select('_id')
            .session(session)
            .lean()
            .exec(),
        ]);

        if (!targetUser) {
          throw new BadRequestException(
            'Người dùng không tồn tại hoặc đã bị khóa',
          );
        }

        if (existingBlock) {
          throw new ConflictException('Bạn đã chặn người dùng này rồi');
        }

        await this.blockModel.create([{ blockerId, blockedId }], {
          session,
        });

        const [currentFollowsTarget, targetFollowsCurrent] = await Promise.all([
          this.relationshipModel
            .findOneAndDelete({
              followerId: blockerId,
              followingId: blockedId,
            })
            .session(session)
            .lean()
            .exec(),

          this.relationshipModel
            .findOneAndDelete({
              followerId: blockedId,
              followingId: blockerId,
            })
            .session(session)
            .lean()
            .exec(),
        ]);

        const counterUpdates: Promise<unknown>[] = [];

        if (currentFollowsTarget) {
          counterUpdates.push(
            this.userModel
              .updateOne(
                {
                  _id: blockerId,
                  isDeleted: false,
                  followingCount: { $gt: 0 },
                },
                { $inc: { followingCount: -1 } },
                { session },
              )
              .exec(),

            this.userModel
              .updateOne(
                {
                  _id: blockedId,
                  isDeleted: false,
                  followersCount: { $gt: 0 },
                },
                { $inc: { followersCount: -1 } },
                { session },
              )
              .exec(),
          );
        }

        if (targetFollowsCurrent) {
          counterUpdates.push(
            this.userModel
              .updateOne(
                {
                  _id: blockedId,
                  isDeleted: false,
                  followingCount: { $gt: 0 },
                },
                { $inc: { followingCount: -1 } },
                { session },
              )
              .exec(),

            this.userModel
              .updateOne(
                {
                  _id: blockerId,
                  isDeleted: false,
                  followersCount: { $gt: 0 },
                },
                { $inc: { followersCount: -1 } },
                { session },
              )
              .exec(),
          );
        }

        if (counterUpdates.length > 0) {
          await Promise.all(counterUpdates);
        }
      });

      return {
        success: true,
        message: 'Đã chặn người dùng thành công',
      };
    } catch (error: unknown) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Bạn đã chặn người dùng này rồi');
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  async unblockUser(currentUserId: string, targetUserId: string) {
    const blockerId = this.toObjectId(
      currentUserId,
      'ID người dùng hiện tại không hợp lệ',
    );
    const blockedId = this.toObjectId(
      targetUserId,
      'ID người dùng không hợp lệ',
    );

    const deleted = await this.blockModel.findOneAndDelete({
      blockerId,
      blockedId,
    });

    if (!deleted) {
      throw new BadRequestException('Bạn chưa chặn người dùng này');
    }

    return { success: true, message: 'Đã bỏ chặn người dùng' };
  }

  async getBlockedUsers(userId: string) {
    const blockerId = this.toObjectId(userId, 'ID người dùng không hợp lệ');

    const blocks = await this.blockModel
      .find({ blockerId })
      .populate(
        'blockedId',
        'publicId username fullname avatar streakCount isDeleted',
      )
      .lean()
      .exec();

    const formattedData = blocks
      .map((block) => {
        const user = block.blockedId as unknown as PopulatedBlockedUser | null;

        if (!user || user.isDeleted) return null;

        return {
          id: user._id.toString(),
          publicId: user.publicId,
          username: user.username,
          fullname: user.fullname,
          avatar: user.avatar,
          streakCount: user.streakCount,
        };
      })
      .filter((user): user is NonNullable<typeof user> => user !== null);

    return { success: true, data: formattedData };
  }
}
