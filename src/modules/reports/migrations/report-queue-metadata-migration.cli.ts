import {
  REPORT_QUEUE_MIGRATION_DEFAULT_BATCH_SIZE,
  REPORT_QUEUE_MIGRATION_MAX_BATCH_SIZE,
  type ReportQueueMigrationOptions,
} from './report-queue-metadata.migration';

export const REPORT_QUEUE_MIGRATION_CONFIRMATION =
  'MIGRATE_REPORT_QUEUE_METADATA';

type Environment = Readonly<Record<string, string | undefined>>;

export type ReportQueueMigrationCommand = Readonly<{
  uri: string;
  expectedDatabase?: string;
  options: ReportQueueMigrationOptions;
}>;

const readArgument = (
  argv: readonly string[],
  name: string,
): string | undefined => {
  const prefix = `${name}=`;
  const values = argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length).trim());
  if (values.length > 1) throw new Error(`${name} bị lặp`);
  if (values.length === 0) return undefined;
  if (!values[0]) throw new Error(`${name} không được rỗng`);
  return values[0];
};

export const parseReportQueueMigrationCommand = (
  argv: readonly string[],
  environment: Environment,
): ReportQueueMigrationCommand => {
  for (const argument of argv) {
    if (
      argument !== '--execute' &&
      !argument.startsWith('--database=') &&
      !argument.startsWith('--batch-size=')
    ) {
      throw new Error(`Tham số không hỗ trợ: ${argument}`);
    }
  }

  const execute = argv.includes('--execute');
  const uri = environment.REPORT_QUEUE_MIGRATION_URI?.trim();
  if (!uri) throw new Error('REPORT_QUEUE_MIGRATION_URI là bắt buộc');
  const expectedDatabase = readArgument(argv, '--database');
  const batchSize = Number(
    readArgument(argv, '--batch-size') ??
      REPORT_QUEUE_MIGRATION_DEFAULT_BATCH_SIZE,
  );
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > REPORT_QUEUE_MIGRATION_MAX_BATCH_SIZE
  ) {
    throw new Error(
      `--batch-size phải từ 1 đến ${REPORT_QUEUE_MIGRATION_MAX_BATCH_SIZE}`,
    );
  }
  if (execute && !expectedDatabase) {
    throw new Error('Execute yêu cầu --database=<database-name>');
  }
  if (
    expectedDatabase &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(expectedDatabase)
  ) {
    throw new Error('Tên database không hợp lệ');
  }
  if (
    execute &&
    environment.REPORT_QUEUE_MIGRATION_CONFIRMATION !==
      REPORT_QUEUE_MIGRATION_CONFIRMATION
  ) {
    throw new Error(
      `Execute yêu cầu REPORT_QUEUE_MIGRATION_CONFIRMATION=${REPORT_QUEUE_MIGRATION_CONFIRMATION}`,
    );
  }

  return Object.freeze({
    uri,
    expectedDatabase,
    options: Object.freeze({ execute, batchSize }),
  });
};

export const assertReportQueueMigrationDatabase = (
  actual: string,
  expected?: string,
): void => {
  if (new Set(['admin', 'config', 'local']).has(actual.toLowerCase())) {
    throw new Error(`Database bị cấm: ${actual}`);
  }
  if (expected && actual !== expected) {
    throw new Error(
      `Database không khớp: expected=${expected}, actual=${actual}`,
    );
  }
};
