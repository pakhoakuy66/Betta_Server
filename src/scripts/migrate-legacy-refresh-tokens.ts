import { config } from 'dotenv';
import mongoose from 'mongoose';
import {
  assertMigrationDatabaseTarget,
  parseLegacyRefreshTokenMigrationCommand,
  readMigrationMongoUri,
} from '../modules/auth/migrations/legacy-refresh-token-migration.cli';
import {
  type LegacyRefreshTokenUser,
  migrateLegacyRefreshTokens,
} from '../modules/auth/migrations/legacy-refresh-token.migration';

config();

async function main(): Promise<void> {
  const command = parseLegacyRefreshTokenMigrationCommand(
    process.argv.slice(2),
    process.env,
  );

  const uri = readMigrationMongoUri(process.env);

  await mongoose.connect(uri);

  const database = mongoose.connection.db;

  if (!database) {
    throw new Error('MongoDB connection chưa sẵn sàng');
  }

  const databaseName = database.databaseName;

  assertMigrationDatabaseTarget(databaseName, command.expectedDatabase);

  const collection = database.collection<LegacyRefreshTokenUser>('users');

  const result = await migrateLegacyRefreshTokens(collection, command.options);

  console.log(
    JSON.stringify(
      {
        success: true,
        database: databaseName,
        ...result,
      },
      null,
      2,
    ),
  );
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Legacy refresh-token migration thất bại';

    console.error(message);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Không thể đóng kết nối MongoDB';

      console.error(message);
      process.exitCode = 1;
    }
  }
}

void run();
