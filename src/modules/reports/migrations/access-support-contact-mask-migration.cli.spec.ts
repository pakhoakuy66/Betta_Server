import { describe, expect, it } from '@jest/globals';
import {
  ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION,
  assertAccessSupportContactMaskMigrationDatabase,
  parseAccessSupportContactMaskMigrationCommand,
} from './access-support-contact-mask-migration.cli';

describe('access-support contact mask migration CLI', () => {
  it('defaults to bounded dry-run and requires a dedicated URI', () => {
    expect(
      parseAccessSupportContactMaskMigrationCommand([], {
        ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_URI: 'test-migration-uri',
      }),
    ).toMatchObject({
      expectedDatabase: undefined,
      options: { execute: false, batchSize: 250 },
    });
    expect(() => parseAccessSupportContactMaskMigrationCommand([], {})).toThrow(
      'ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_URI',
    );
  });

  it('requires exact database binding and confirmation for execute', () => {
    const environment = {
      ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_URI: 'test-migration-uri',
    };
    expect(() =>
      parseAccessSupportContactMaskMigrationCommand(['--execute'], environment),
    ).toThrow('--database');
    expect(() =>
      parseAccessSupportContactMaskMigrationCommand(
        ['--execute', '--database=betta_stage'],
        environment,
      ),
    ).toThrow('ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION');
    expect(
      parseAccessSupportContactMaskMigrationCommand(
        ['--execute', '--database=betta_stage', '--batch-size=500'],
        {
          ...environment,
          ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION:
            ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_CONFIRMATION,
        },
      ),
    ).toMatchObject({
      expectedDatabase: 'betta_stage',
      options: { execute: true, batchSize: 500 },
    });
  });

  it('rejects forbidden and mismatched database targets', () => {
    expect(() =>
      assertAccessSupportContactMaskMigrationDatabase('admin'),
    ).toThrow('Database bị cấm');
    expect(() =>
      assertAccessSupportContactMaskMigrationDatabase(
        'betta_prod',
        'betta_stage',
      ),
    ).toThrow('Database không khớp');
  });
});
