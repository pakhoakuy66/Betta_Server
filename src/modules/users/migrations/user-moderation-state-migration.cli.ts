import { ObjectId } from 'mongodb';
import {
  DEFAULT_USER_MODERATION_MIGRATION_BATCH_SIZE,
  DEFAULT_USER_MODERATION_MIGRATION_MAX_DOCUMENTS,
  MAX_USER_MODERATION_MIGRATION_BATCH_SIZE,
  MAX_USER_MODERATION_MIGRATION_DOCUMENTS,
  type UserModerationMigrationDirection,
  type UserModerationMigrationOptions,
} from './user-moderation-state.migration';

export const USER_MODERATION_FORWARD_CONFIRMATION =
  'MIGRATE_USER_MODERATION_STATE';
export const USER_MODERATION_ROLLBACK_CONFIRMATION =
  'ROLLBACK_USER_MODERATION_STATE';

export type UserModerationMigrationEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type UserModerationMigrationCommand = Readonly<{
  expectedDatabase?: string;
  options: UserModerationMigrationOptions;
}>;

const FORBIDDEN_DATABASE_NAMES = new Set(['admin', 'config', 'local']);

const readSingleArgument = (
  argv: readonly string[],
  name: string,
): string | undefined => {
  const prefix = `${name}=`;
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) {
    throw new Error(`${name} cannot be supplied more than once`);
  }
  if (matches.length === 0) return undefined;
  const value = matches[0].slice(prefix.length).trim();
  if (!value) throw new Error(`${name} cannot be empty`);
  return value;
};

const readBoundedInteger = (
  argv: readonly string[],
  name: string,
  fallback: number,
  maximum: number,
): number => {
  const raw = readSingleArgument(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
};

const assertSupportedArguments = (argv: readonly string[]): void => {
  if (argv.filter((argument) => argument === '--execute').length > 1) {
    throw new Error('--execute cannot be supplied more than once');
  }
  for (const argument of argv) {
    const supported =
      argument === '--execute' ||
      argument.startsWith('--direction=') ||
      argument.startsWith('--database=') ||
      argument.startsWith('--batch-size=') ||
      argument.startsWith('--max-documents=') ||
      argument.startsWith('--after-id=');
    if (!supported) throw new Error(`Unsupported argument: ${argument}`);
  }
};

const readDirection = (
  argv: readonly string[],
): UserModerationMigrationDirection => {
  const value = readSingleArgument(argv, '--direction') ?? 'forward';
  if (value !== 'forward' && value !== 'rollback') {
    throw new Error('--direction must be forward or rollback');
  }
  return value;
};

const readAfterId = (argv: readonly string[]): ObjectId | undefined => {
  const value = readSingleArgument(argv, '--after-id');
  if (value === undefined) return undefined;
  if (!/^[a-fA-F0-9]{24}$/.test(value)) {
    throw new Error('--after-id must be a 24-character ObjectId');
  }
  return new ObjectId(value);
};

export const readUserModerationMigrationMongoUri = (
  environment: UserModerationMigrationEnvironment,
): string => {
  const uri = environment.DATABASE_URL?.trim();
  if (!uri) throw new Error('DATABASE_URL is required');
  return uri;
};

export const assertSafeUserModerationDatabaseName = (
  databaseName: string,
): void => {
  const normalized = databaseName.trim().toLowerCase();
  if (
    FORBIDDEN_DATABASE_NAMES.has(normalized) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(databaseName)
  ) {
    throw new Error(`Migration database is not allowed: ${databaseName}`);
  }
};

export const assertUserModerationMigrationDatabaseTarget = (
  actualDatabase: string,
  expectedDatabase?: string,
): void => {
  assertSafeUserModerationDatabaseName(actualDatabase);
  if (expectedDatabase !== undefined && actualDatabase !== expectedDatabase) {
    throw new Error(
      `Database mismatch: expected=${expectedDatabase}, actual=${actualDatabase}`,
    );
  }
};

export const parseUserModerationMigrationCommand = (
  argv: readonly string[],
  environment: UserModerationMigrationEnvironment,
): UserModerationMigrationCommand => {
  assertSupportedArguments(argv);
  const execute = argv.includes('--execute');
  const direction = readDirection(argv);
  const expectedDatabase = readSingleArgument(argv, '--database');
  const batchSize = readBoundedInteger(
    argv,
    '--batch-size',
    DEFAULT_USER_MODERATION_MIGRATION_BATCH_SIZE,
    MAX_USER_MODERATION_MIGRATION_BATCH_SIZE,
  );
  const maxDocuments = readBoundedInteger(
    argv,
    '--max-documents',
    DEFAULT_USER_MODERATION_MIGRATION_MAX_DOCUMENTS,
    MAX_USER_MODERATION_MIGRATION_DOCUMENTS,
  );
  const afterId = readAfterId(argv);

  if (execute && !expectedDatabase) {
    throw new Error('Execute requires --database=<database-name>');
  }
  if (expectedDatabase !== undefined) {
    assertSafeUserModerationDatabaseName(expectedDatabase);
  }
  const requiredConfirmation =
    direction === 'forward'
      ? USER_MODERATION_FORWARD_CONFIRMATION
      : USER_MODERATION_ROLLBACK_CONFIRMATION;
  if (
    execute &&
    environment.USER_MODERATION_MIGRATION_CONFIRMATION !== requiredConfirmation
  ) {
    throw new Error(
      `Execute requires USER_MODERATION_MIGRATION_CONFIRMATION=${requiredConfirmation}`,
    );
  }

  return Object.freeze({
    expectedDatabase,
    options: Object.freeze({
      execute,
      direction,
      batchSize,
      maxDocuments,
      afterId,
    }),
  });
};
