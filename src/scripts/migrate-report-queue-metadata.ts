import { MongoClient } from 'mongodb';
import {
  assertReportQueueMigrationDatabase,
  parseReportQueueMigrationCommand,
} from '../modules/reports/migrations/report-queue-metadata-migration.cli';
import {
  migrateReportQueueMetadata,
  type ReportQueueMigrationDocument,
  type ReportQueueMigrationResult,
} from '../modules/reports/migrations/report-queue-metadata.migration';

const run = async (): Promise<ReportQueueMigrationResult> => {
  const command = parseReportQueueMigrationCommand(
    process.argv.slice(2),
    process.env,
  );
  const client = new MongoClient(command.uri);
  try {
    await client.connect();
    const database = client.db();
    assertReportQueueMigrationDatabase(
      database.databaseName,
      command.expectedDatabase,
    );
    const collections = {
      reports: database.collection<ReportQueueMigrationDocument>('reports'),
      systemReports:
        database.collection<ReportQueueMigrationDocument>('system_reports'),
      users: database.collection('users'),
    };
    let aggregate: ReportQueueMigrationResult = Object.freeze({
      execute: command.options.execute,
      reportsScanned: 0,
      systemReportsScanned: 0,
      reportsPlanned: 0,
      systemReportsPlanned: 0,
      updated: 0,
      hasMore: false,
    });

    do {
      const batch = await migrateReportQueueMetadata(
        collections,
        command.options,
      );
      aggregate = Object.freeze({
        execute: batch.execute,
        reportsScanned: aggregate.reportsScanned + batch.reportsScanned,
        systemReportsScanned:
          aggregate.systemReportsScanned + batch.systemReportsScanned,
        reportsPlanned: aggregate.reportsPlanned + batch.reportsPlanned,
        systemReportsPlanned:
          aggregate.systemReportsPlanned + batch.systemReportsPlanned,
        updated: aggregate.updated + batch.updated,
        hasMore: batch.hasMore,
      });

      // Dry-run does not mutate candidates, so one bounded batch is intentional.
      if (!command.options.execute) break;
    } while (aggregate.hasMore);

    return aggregate;
  } finally {
    await client.close();
  }
};

void run()
  .then((result) => {
    console.log(JSON.stringify({ success: true, ...result }, null, 2));
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Report queue metadata migration thất bại',
    );
    process.exitCode = 1;
  });
