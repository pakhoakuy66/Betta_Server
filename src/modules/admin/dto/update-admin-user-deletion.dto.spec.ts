import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminUserDeletionOperation } from '../constants/admin-user-deletion.constants';
import { UpdateAdminUserDeletionDto } from './update-admin-user-deletion.dto';

const validate = (value: Record<string, unknown>) =>
  validateSync(plainToInstance(UpdateAdminUserDeletionDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('UpdateAdminUserDeletionDto', () => {
  it.each(Object.values(AdminUserDeletionOperation))(
    'accepts a bounded %s request',
    (operation) => {
      expect(
        validate({
          operation,
          expectedVersion: 2,
          reasonCode: 'moderation_policy',
          reasonNote: 'Reviewed by moderation operator',
          correlationId: 'user-deletion-20260818-0001',
        }),
      ).toHaveLength(0);
    },
  );

  it('rejects hard delete, stale shape and unknown fields', () => {
    expect(
      validate({
        operation: 'HARD_DELETE',
        expectedVersion: -1,
        reasonCode: '$where',
        reasonNote: '',
        purgeContent: true,
      }).length,
    ).toBeGreaterThan(0);
  });
});
