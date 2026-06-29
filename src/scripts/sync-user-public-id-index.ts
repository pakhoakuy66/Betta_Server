import { config } from 'dotenv';
import mongoose from 'mongoose';
import { UserSchema } from '../modules/users/schemas/user.schema';

config();

function getMongoUri(): string {
  const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;

  if (!mongoUri) {
    throw new Error('Missing MONGO_URI or DATABASE_URL');
  }

  return mongoUri;
}

const UserModel = mongoose.model('User', UserSchema);

async function assertNoMissingPublicId() {
  const missingCount = await UserModel.countDocuments({
    $or: [
      { publicId: { $exists: false } },
      { publicId: null },
      { publicId: '' },
    ],
  });

  if (missingCount > 0) {
    throw new Error(
      `Cannot create required publicId index: ${missingCount} users missing publicId`,
    );
  }
}

async function syncPublicIdIndex() {
  const indexes = await UserModel.collection.indexes();

  const publicIdIndexes = indexes.filter(
    (index) => index.key && index.key.publicId === 1,
  );

  for (const index of publicIdIndexes) {
    if (index.name) {
      await UserModel.collection.dropIndex(index.name);
    }
  }

  await UserModel.collection.createIndex(
    { publicId: 1 },
    {
      unique: true,
      name: 'users_publicId_unique',
    },
  );
}

async function main() {
  await mongoose.connect(getMongoUri());

  await assertNoMissingPublicId();
  await syncPublicIdIndex();

  console.log('Synced required unique publicId index successfully');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
