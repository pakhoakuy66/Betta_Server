import {
  DEFAULT_MIGRATION_BATCH_SIZE,
  DEFAULT_MIGRATION_MAX_DOCUMENTS,
  MAX_MIGRATION_BATCH_SIZE,
  MAX_MIGRATION_DOCUMENTS,
  type LegacyRefreshTokenMigrationOptions,
} from './legacy-refresh-token.migration';

export const REQUIRED_MIGRATION_CONFIRMATION = 'UNSET_USERS_REFRESH_TOKEN';

export type MigrationEnvironment = Readonly<Record<string, string | undefined>>;

export type LegacyRefreshTokenMigrationCommand = {
  options: LegacyRefreshTokenMigrationOptions;
  expectedDatabase?: string;
};

const forbiddenDatabaseNames = new Set(['admin', 'config', 'local']);

function readSingleArgument(
  argv: readonly string[],
  name: string,
): string | undefined {
  const prefix = `${name}=`;

  const matches = argv.filter((argument) => argument.startsWith(prefix));

  if (matches.length > 1) {
    throw new Error(`${name} không được truyền nhiều lần`);
  }

  if (matches.length === 0) {
    return undefined;
  }

  const value = matches[0].slice(prefix.length).trim();

  if (!value) {
    throw new Error(`${name} không được để trống`);
  }

  return value;
}

function readBoundedInteger(
  argv: readonly string[],
  name: string,
  fallback: number,
  maximum: number,
): number {
  const rawValue = readSingleArgument(argv, name);

  if (rawValue === undefined) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} phải là số nguyên từ 1 đến ${maximum}`);
  }

  return value;
}

function assertSupportedArguments(argv: readonly string[]): void {
  const executeCount = argv.filter(
    (argument) => argument === '--execute',
  ).length;

  if (executeCount > 1) {
    throw new Error('--execute không được truyền nhiều lần');
  }

  for (const argument of argv) {
    const supported =
      argument === '--execute' ||
      argument.startsWith('--database=') ||
      argument.startsWith('--batch-size=') ||
      argument.startsWith('--max-documents=');

    if (!supported) {
      throw new Error(`Argument không được hỗ trợ: ${argument}`);
    }
  }
}

export function readMigrationMongoUri(
  environment: MigrationEnvironment,
): string {
  const uri = environment.DATABASE_URL?.trim();

  if (!uri) {
    throw new Error('Thiếu DATABASE_URL');
  }

  return uri;
}

export function assertSafeDatabaseName(databaseName: string): void {
  const normalizedName = databaseName.trim().toLowerCase();

  if (
    forbiddenDatabaseNames.has(normalizedName) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(databaseName)
  ) {
    throw new Error(`Database không được phép chạy migration: ${databaseName}`);
  }
}

export function assertMigrationDatabaseTarget(
  actualDatabase: string,
  expectedDatabase?: string,
): void {
  assertSafeDatabaseName(actualDatabase);

  if (expectedDatabase !== undefined && expectedDatabase !== actualDatabase) {
    throw new Error(
      `Database không khớp: expected=${expectedDatabase}, actual=${actualDatabase}`,
    );
  }
}

export function parseLegacyRefreshTokenMigrationCommand(
  argv: readonly string[],
  environment: MigrationEnvironment,
): LegacyRefreshTokenMigrationCommand {
  assertSupportedArguments(argv);

  const execute = argv.includes('--execute');

  const expectedDatabase = readSingleArgument(argv, '--database');

  const batchSize = readBoundedInteger(
    argv,
    '--batch-size',
    DEFAULT_MIGRATION_BATCH_SIZE,
    MAX_MIGRATION_BATCH_SIZE,
  );

  const maxDocuments = readBoundedInteger(
    argv,
    '--max-documents',
    DEFAULT_MIGRATION_MAX_DOCUMENTS,
    MAX_MIGRATION_DOCUMENTS,
  );

  if (execute && !expectedDatabase) {
    throw new Error('Execute bắt buộc truyền --database=<tên-database>');
  }

  if (
    execute &&
    environment.LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION !==
      REQUIRED_MIGRATION_CONFIRMATION
  ) {
    throw new Error(
      `Execute yêu cầu LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION=${REQUIRED_MIGRATION_CONFIRMATION}`,
    );
  }

  return {
    options: {
      execute,
      batchSize,
      maxDocuments,
    },
    expectedDatabase,
  };
}
