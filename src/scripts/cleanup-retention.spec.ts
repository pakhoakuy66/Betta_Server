import { describe, expect, it } from '@jest/globals';
import { parseRetentionArguments } from './cleanup-retention.cli';

describe('cleanup-retention CLI', () => {
  it('is dry-run retention by default', () => {
    expect(parseRetentionArguments([])).toEqual({
      execute: false,
      mode: 'retention',
    });
  });

  it('parses explicit safe options', () => {
    expect(
      parseRetentionArguments([
        '--execute',
        '--mode',
        'test-marker',
        '--max-documents',
        '25',
        '--confirm',
        'confirmation',
        '--backup-reference',
        'atlas-backup-20260829',
      ]),
    ).toEqual({
      execute: true,
      mode: 'test-marker',
      maxDocuments: 25,
      confirmation: 'confirmation',
      backupReference: 'atlas-backup-20260829',
    });
  });

  it('rejects unknown options and invalid values', () => {
    expect(() => parseRetentionArguments(['--unknown'])).toThrow(
      'Tham số không được hỗ trợ',
    );
    expect(() => parseRetentionArguments(['--max-documents', '0'])).toThrow(
      'số nguyên dương',
    );
    expect(() => parseRetentionArguments(['--mode', 'all'])).toThrow(
      'retention hoặc test-marker',
    );
  });
});
