import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { acquireSocialGraphPairLock } from '../utils/social-graph-lock.util';
import { Block } from '../schemas/block.schema';
import { Relationship } from '../schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';

type MongoDuplicateKeyError = {
  code?: number;
};

type PopulatedBlockedUser = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar?: string;
  streakCount?: number;
  isDeleted?: boolean;
};

const USER_PUBLIC_ID_REGEX = /^usr_[A-Za-z0-9_-]{6,40}$/;

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

  private async resolveActiveUserObjectId(
    identifier: string,
  ): Promise<Types.ObjectId> {
    const user = await this.userModel
      .findOne({
        ...this.buildUserLookupFilter(identifier),
        isDeleted: false,
        status: 'active',
      })
      .select('_id')
      .lean()
      .exec();

    if (!user) {
      throw new BadRequestException('Người dùng không tồn tại hoặc đã bị khóa');
    }

    return user._id;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  async blockUser(currentUserId: string, targetUserId: string) {
    const blockerId = this.toObjectId(
      currentUserId,
      'ID người dùng hiện tại không hợp lệ',
    );
    const blockedId = await this.resolveActiveUserObjectId(targetUserId);

    if (blockedId.equals(blockerId)) {
      throw new BadRequestException('Bạn không thể tự chặn chính mình');
    }

    const session = await this.connection.startSession();

    try {
      await session.withTransaction(async () => {
        await acquireSocialGraphPairLock(
          this.userModel,
          blockerId,
          blockedId,
          session,
        );

        const blockerExists = await this.userModel
          .exists({
            _id: blockerId,
            isDeleted: false,
            status: 'active',
          })
          .session(session);

        if (!blockerExists) {
          throw new BadRequestException(
            'Tài khoản hiện tại không thể thực hiện thao tác này',
          );
        }

        const blockedUserExists = await this.userModel
          .exists({
            _id: blockedId,
            isDeleted: false,
            status: 'active',
          })
          .session(session);

        if (!blockedUserExists) {
          throw new BadRequestException(
            'Người dùng không tồn tại hoặc đã bị khóa',
          );
        }

        const existingBlock = await this.blockModel
          .exists({
            blockerId,
            blockedId,
          })
          .session(session);

        if (existingBlock) {
          throw new ConflictException('Bạn đã chặn người dùng này rồi');
        }

        await this.blockModel.create([{ blockerId, blockedId }], { session });

        const currentFollowsTarget =
          await this.relationshipModel.findOneAndDelete(
            {
              followerId: blockerId,
              followingId: blockedId,
            },
            { session },
          );

        const targetFollowsCurrent =
          await this.relationshipModel.findOneAndDelete(
            {
              followerId: blockedId,
              followingId: blockerId,
            },
            { session },
          );

        if (currentFollowsTarget) {
          await this.decrementCounter(blockerId, 'followingCount', session);
          await this.decrementCounter(blockedId, 'followersCount', session);
        }

        if (targetFollowsCurrent) {
          await this.decrementCounter(blockedId, 'followingCount', session);
          await this.decrementCounter(blockerId, 'followersCount', session);
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
    const blockedId = await this.resolveActiveUserObjectId(targetUserId);

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
          id: user.publicId,
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
