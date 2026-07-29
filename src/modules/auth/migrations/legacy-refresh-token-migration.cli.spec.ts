import { describe, expect, it } from '@jest/globals';
import {
  REQUIRED_MIGRATION_CONFIRMATION,
  assertMigrationDatabaseTarget,
  assertSafeDatabaseName,
  parseLegacyRefreshTokenMigrationCommand,
  readMigrationMongoUri,
} from './legacy-refresh-token-migration.cli';

describe('Legacy refresh-token migration CLI guards', () => {
  it('parses a safe dry-run command', () => {
    expect(
      parseLegacyRefreshTokenMigrationCommand(
        [
          '--database=betta_developer',
          '--batch-size=200',
          '--max-documents=5000',
        ],
        {},
      ),
    ).toEqual({
      expectedDatabase: 'betta_developer',
      options: {
        execute: false,
        batchSize: 200,
        maxDocuments: 5000,
      },
    });
  });

  it('parses a confirmed execute command', () => {
    expect(
      parseLegacyRefreshTokenMigrationCommand(
        ['--execute', '--database=betta_developer'],
        {
          LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION:
            REQUIRED_MIGRATION_CONFIRMATION,
        },
      ),
    ).toEqual({
      expectedDatabase: 'betta_developer',
      options: {
        execute: true,
        batchSize: 500,
        maxDocuments: 10_000,
      },
    });
  });

  it('rejects execute without database', () => {
    expect(() =>
      parseLegacyRefreshTokenMigrationCommand(['--execute'], {
        LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION:
          REQUIRED_MIGRATION_CONFIRMATION,
      }),
    ).toThrow('Execute bắt buộc truyền --database=<tên-database>');
  });

  it('rejects execute without exact confirmation', () => {
    expect(() =>
      parseLegacyRefreshTokenMigrationCommand(
        ['--execute', '--database=betta_developer'],
        {
          LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION: 'WRONG',
        },
      ),
    ).toThrow('Execute yêu cầu LEGACY_REFRESH_TOKEN_MIGRATION_CONFIRMATION');
  });

  it('rejects unsupported arguments', () => {
    expect(() =>
      parseLegacyRefreshTokenMigrationCommand(['--force'], {}),
    ).toThrow('Argument không được hỗ trợ: --force');
  });

  it.each([
    '--batch-size=0',
    '--batch-size=1001',
    '--batch-size=abc',
    '--max-documents=0',
    '--max-documents=100001',
    '--max-documents=1.5',
  ])('rejects invalid numeric argument %s', (argument) => {
    expect(() =>
      parseLegacyRefreshTokenMigrationCommand([argument], {}),
    ).toThrow();
  });

  it.each(['admin', 'config', 'local', 'ADMIN'])(
    'rejects forbidden database %s',
    (databaseName) => {
      expect(() => assertSafeDatabaseName(databaseName)).toThrow();
    },
  );

  it('rejects a database mismatch', () => {
    expect(() =>
      assertMigrationDatabaseTarget('betta_production', 'betta_developer'),
    ).toThrow(
      'Database không khớp: expected=betta_developer, actual=betta_production',
    );
  });

  it('accepts an exact safe database target', () => {
    expect(() =>
      assertMigrationDatabaseTarget('betta_developer', 'betta_developer'),
    ).not.toThrow();
  });

  it('reads only DATABASE_URL', () => {
    expect(
      readMigrationMongoUri({
        DATABASE_URL: ' mongodb://localhost/betta ',
        MONGODB_URI: 'mongodb://wrong/database',
      }),
    ).toBe('mongodb://localhost/betta');
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() =>
      readMigrationMongoUri({
        MONGODB_URI: 'mongodb://wrong/database',
      }),
    ).toThrow('Thiếu DATABASE_URL');
  });
});
