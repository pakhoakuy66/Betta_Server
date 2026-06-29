import { config } from 'dotenv';
import mongoose from 'mongoose';
import { UserSchema } from '../modules/users/schemas/user.schema';
import { generateUserPublicId } from '../modules/users/utils/generate-public-id';

config();

function getMongoUri(): string {
  const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;

  if (!mongoUri) {
    throw new Error('Missing MONGO_URI or DATABASE_URL');
  }

  return mongoUri;
}

const UserModel = mongoose.model('User', UserSchema);

async function assignPublicId(userId: mongoose.Types.ObjectId) {
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const publicId = generateUserPublicId();

      await UserModel.updateOne(
        {
          _id: userId,
          $or: [{ publicId: { $exists: false } }, { publicId: null }],
        },
        { $set: { publicId } },
      );

      return;
    } catch (error: unknown) {
      const mongoError = error as {
        code?: number;
        keyPattern?: Record<string, number>;
      };

      // Nếu trùng publicId thì sinh lại. Các lỗi khác phải throw để không che lỗi thật.
      if (mongoError.code === 11000 && mongoError.keyPattern?.publicId) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Cannot assign publicId for user ${userId.toString()}`);
}

async function main() {
  await mongoose.connect(getMongoUri());

  const users = await UserModel.find({
    $or: [{ publicId: { $exists: false } }, { publicId: null }],
  })
    .select('_id')
    .lean();

  for (const user of users) {
    await assignPublicId(user._id);
  }

  console.log(`Backfilled publicId for ${users.length} users`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
