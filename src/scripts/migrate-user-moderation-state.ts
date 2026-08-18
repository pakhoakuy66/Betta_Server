import { config } from 'dotenv';
import mongoose from 'mongoose';
import {
  assertUserModerationMigrationDatabaseTarget,
  parseUserModerationMigrationCommand,
  readUserModerationMigrationMongoUri,
} from '../modules/users/migrations/user-moderation-state-migration.cli';
import {
  migrateUserModerationState,
  type UserModerationMigrationDocument,
} from '../modules/users/migrations/user-moderation-state.migration';

config();

const main = async (): Promise<void> => {
  const command = parseUserModerationMigrationCommand(
    process.argv.slice(2),
    process.env,
  );
  const uri = readUserModerationMigrationMongoUri(process.env);
  await mongoose.connect(uri);
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection is not ready');
  assertUserModerationMigrationDatabaseTarget(
    database.databaseName,
    command.expectedDatabase,
  );
  const collection =
    database.collection<UserModerationMigrationDocument>('users');
  const result = await migrateUserModerationState(collection, command.options);
  console.log(
    JSON.stringify(
      { success: true, database: database.databaseName, ...result },
      null,
      2,
    ),
  );
};

const run = async (): Promise<void> => {
  try {
    await main();
  } catch (error: unknown) {
    console.error(
      error instanceof Error
        ? error.message
        : 'User moderation migration failed',
    );
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      console.error('Could not close the MongoDB connection');
      process.exitCode = 1;
    }
  }
};

void run();
