import { describe, expect, it } from '@jest/globals';
import {
  assertReportQueueMigrationDatabase,
  parseReportQueueMigrationCommand,
  REPORT_QUEUE_MIGRATION_CONFIRMATION,
} from './report-queue-metadata-migration.cli';

describe('report queue metadata migration CLI', () => {
  it('defaults to dry-run and requires an explicit URI', () => {
    expect(
      parseReportQueueMigrationCommand([], {
        REPORT_QUEUE_MIGRATION_URI: 'mongodb://integration/report_queue',
      }),
    ).toMatchObject({
      expectedDatabase: undefined,
      options: { execute: false, batchSize: 250 },
    });
    expect(() => parseReportQueueMigrationCommand([], {})).toThrow(
      'REPORT_QUEUE_MIGRATION_URI',
    );
  });

  it('requires database binding and confirmation for execute', () => {
    const environment = {
      REPORT_QUEUE_MIGRATION_URI: 'mongodb://integration/report_queue',
    };
    expect(() =>
      parseReportQueueMigrationCommand(['--execute'], environment),
    ).toThrow('--database');

    expect(() =>
      parseReportQueueMigrationCommand(
        ['--execute', '--database=betta_stage'],
        environment,
      ),
    ).toThrow('REPORT_QUEUE_MIGRATION_CONFIRMATION');

    expect(
      parseReportQueueMigrationCommand(
        ['--execute', '--database=betta_stage', '--batch-size=500'],
        {
          ...environment,
          REPORT_QUEUE_MIGRATION_CONFIRMATION:
            REPORT_QUEUE_MIGRATION_CONFIRMATION,
        },
      ),
    ).toMatchObject({
      expectedDatabase: 'betta_stage',
      options: { execute: true, batchSize: 500 },
    });
  });

  it('rejects forbidden and mismatched database targets', () => {
    expect(() => assertReportQueueMigrationDatabase('admin')).toThrow(
      'Database bị cấm',
    );
    expect(() =>
      assertReportQueueMigrationDatabase('betta_prod', 'betta_stage'),
    ).toThrow('Database không khớp');
  });
});
