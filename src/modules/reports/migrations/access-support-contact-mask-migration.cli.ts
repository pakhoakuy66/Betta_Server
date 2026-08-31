import {
  ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_DEFAULT_BATCH_SIZE,
  ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_MAX_BATCH_SIZE,
  type AccessSupportContactMaskMigrationOptions,
} from './access-support-contact-mask.migration';

export const ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION =
  'MIGRATE_ACCESS_SUPPORT_CONTACT_MASKS';

type Environment = Readonly<Record<string, string | undefined>>;

export type AccessSupportContactMaskMigrationCommand = Readonly<{
  uri: string;
  expectedDatabase?: string;
  options: Omit<AccessSupportContactMaskMigrationOptions, 'afterId'>;
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

export const parseAccessSupportContactMaskMigrationCommand = (
  argv: readonly string[],
  environment: Environment,
): AccessSupportContactMaskMigrationCommand => {
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
  const uri = environment.ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_URI?.trim();
  if (!uri) {
    throw new Error('ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_URI là bắt buộc');
  }
  const expectedDatabase = readArgument(argv, '--database');
  const batchSize = Number(
    readArgument(argv, '--batch-size') ??
      ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_DEFAULT_BATCH_SIZE,
  );
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_MAX_BATCH_SIZE
  ) {
    throw new Error(
      `--batch-size phải từ 1 đến ${ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_MAX_BATCH_SIZE}`,
    );
  }
  if (execute && !expectedDatabase) {
    throw new Error('Execute yêu cầu --database=<database-name>');
  }
  if (
    expectedDatabase &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u.test(expectedDatabase)
  ) {
    throw new Error('Tên database không hợp lệ');
  }
  if (
    execute &&
    environment.ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION !==
      ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION
  ) {
    throw new Error(
      `Execute yêu cầu ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION=${ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION}`,
    );
  }

  return Object.freeze({
    uri,
    expectedDatabase,
    options: Object.freeze({ execute, batchSize }),
  });
};

export const assertAccessSupportContactMaskMigrationDatabase = (
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
