import { ConflictException } from '@nestjs/common';
import { ClientSession, Model, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export async function acquireSocialGraphPairLock(
  userModel: Model<User>,
  firstUserId: Types.ObjectId,
  secondUserId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  const orderedIds = [firstUserId, secondUserId].sort((left, right) =>
    left.toString().localeCompare(right.toString()),
  );

  for (const userId of orderedIds) {
    const result = await userModel.updateOne(
      {
        _id: userId,
        isDeleted: false,
      },
      {
        $inc: { socialGraphVersion: 1 },
      },
      { session },
    );

    if (result.matchedCount !== 1) {
      throw new ConflictException(
        'Không thể cập nhật quan hệ người dùng lúc này',
      );
    }
  }
}
