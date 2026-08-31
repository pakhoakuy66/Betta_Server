import { ConfigService } from '@nestjs/config';
import { MongoClient, type ObjectId } from 'mongodb';
import { AccessSupportSecretsConfig } from '../modules/reports/config/access-support-secrets.config';
import {
  assertAccessSupportContactMaskMigrationDatabase,
  parseAccessSupportContactMaskMigrationCommand,
} from '../modules/reports/migrations/access-support-contact-mask-migration.cli';
import {
  migrateAccessSupportContactMasks,
  type AccessSupportContactMaskMigrationDocument,
} from '../modules/reports/migrations/access-support-contact-mask.migration';
import { AccessSupportCryptoService } from '../modules/reports/services/access-support-crypto.service';

type PublicResult = Readonly<{
  success: boolean;
  execute: boolean;
  scanned: number;
  planned: number;
  updated: number;
  failed: number;
}>;

const run = async (): Promise<PublicResult> => {
  const command = parseAccessSupportContactMaskMigrationCommand(
    process.argv.slice(2),
    process.env,
  );
  const secrets = new AccessSupportSecretsConfig(
    new ConfigService(process.env),
  );
  const crypto = new AccessSupportCryptoService(secrets);
  const client = new MongoClient(command.uri);
  try {
    await client.connect();
    const database = client.db();
    assertAccessSupportContactMaskMigrationDatabase(
      database.databaseName,
      command.expectedDatabase,
    );
    const collections = {
      systemReports:
        database.collection<AccessSupportContactMaskMigrationDocument>(
          'system_reports',
        ),
    };
    let afterId: ObjectId | undefined;
    let scanned = 0;
    let planned = 0;
    let updated = 0;
    let failed = 0;

    do {
      const batch = await migrateAccessSupportContactMasks(
        collections,
        crypto,
        {
          ...command.options,
          ...(afterId ? { afterId } : {}),
        },
      );
      scanned += batch.scanned;
      planned += batch.planned;
      updated += batch.updated;
      failed += batch.failed;
      afterId = batch.nextAfterId;

      // Dry-run is intentionally one bounded batch and never mutates data.
      if (!command.options.execute) break;
    } while (afterId);

    return Object.freeze({
      success: failed === 0,
      execute: command.options.execute,
      scanned,
      planned,
      updated,
      failed,
    });
  } finally {
    await client.close();
  }
};

void run()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Access-support contact mask migration thất bại',
    );
    process.exitCode = 1;
  });
