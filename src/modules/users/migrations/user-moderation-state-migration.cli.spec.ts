import { describe, expect, it } from '@jest/globals';
import {
  USER_MODERATION_FORWARD_CONFIRMATION,
  USER_MODERATION_ROLLBACK_CONFIRMATION,
  assertSafeUserModerationDatabaseName,
  assertUserModerationMigrationDatabaseTarget,
  parseUserModerationMigrationCommand,
  readUserModerationMigrationMongoUri,
} from './user-moderation-state-migration.cli';

describe('User moderation migration CLI guards', () => {
  it('defaults to a bounded forward dry-run', () => {
    expect(parseUserModerationMigrationCommand([], {})).toEqual({
      expectedDatabase: undefined,
      options: {
        execute: false,
        direction: 'forward',
        batchSize: 250,
        maxDocuments: 10_000,
        afterId: undefined,
      },
    });
  });

  it.each([
    ['forward', USER_MODERATION_FORWARD_CONFIRMATION],
    ['rollback', USER_MODERATION_ROLLBACK_CONFIRMATION],
  ] as const)('parses confirmed %s execution', (direction, confirmation) => {
    const command = parseUserModerationMigrationCommand(
      [
        '--execute',
        `--direction=${direction}`,
        '--database=betta_development',
        '--batch-size=100',
        '--max-documents=500',
        '--after-id=65f000000000000000000001',
      ],
      { USER_MODERATION_MIGRATION_CONFIRMATION: confirmation },
    );
    expect(command.options).toMatchObject({
      execute: true,
      direction,
      batchSize: 100,
      maxDocuments: 500,
    });
    expect(command.options.afterId?.toHexString()).toBe(
      '65f000000000000000000001',
    );
  });

  it('requires database and direction-specific confirmation for execute', () => {
    expect(() =>
      parseUserModerationMigrationCommand(['--execute'], {
        USER_MODERATION_MIGRATION_CONFIRMATION:
          USER_MODERATION_FORWARD_CONFIRMATION,
      }),
    ).toThrow('Execute requires --database');
    expect(() =>
      parseUserModerationMigrationCommand(
        ['--execute', '--direction=rollback', '--database=betta_dev'],
        {
          USER_MODERATION_MIGRATION_CONFIRMATION:
            USER_MODERATION_FORWARD_CONFIRMATION,
        },
      ),
    ).toThrow(USER_MODERATION_ROLLBACK_CONFIRMATION);
  });

  it.each([
    '--direction=sideways',
    '--after-id=invalid',
    '--batch-size=0',
    '--batch-size=1001',
    '--max-documents=100001',
    '--force',
  ])('rejects unsafe argument %s', (argument) => {
    expect(() => parseUserModerationMigrationCommand([argument], {})).toThrow();
  });

  it.each(['admin', 'config', 'local', 'ADMIN', 'bad name'])(
    'rejects unsafe database %s',
    (databaseName) => {
      expect(() =>
        assertSafeUserModerationDatabaseName(databaseName),
      ).toThrow();
    },
  );

  it('requires exact database target', () => {
    expect(() =>
      assertUserModerationMigrationDatabaseTarget('betta_dev', 'betta_test'),
    ).toThrow('Database mismatch');
    expect(() =>
      assertUserModerationMigrationDatabaseTarget('betta_dev', 'betta_dev'),
    ).not.toThrow();
  });

  it('reads only DATABASE_URL', () => {
    expect(
      readUserModerationMigrationMongoUri({
        DATABASE_URL: ' mongodb://localhost/betta_dev ',
        MONGODB_URI: 'mongodb://wrong/database',
      }),
    ).toBe('mongodb://localhost/betta_dev');
    expect(() =>
      readUserModerationMigrationMongoUri({
        MONGODB_URI: 'mongodb://wrong/database',
      }),
    ).toThrow('DATABASE_URL is required');
  });
});
