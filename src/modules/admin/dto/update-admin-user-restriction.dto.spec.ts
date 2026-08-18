import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { AdminUserRestrictionOperation } from '../constants/admin-user-restriction.constants';
import { UpdateAdminUserRestrictionDto } from './update-admin-user-restriction.dto';

const validate = (value: Record<string, unknown>) =>
  validateSync(plainToInstance(UpdateAdminUserRestrictionDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('UpdateAdminUserRestrictionDto', () => {
  it('accepts a bounded temporary suspension request', () => {
    expect(
      validate({
        operation: AdminUserRestrictionOperation.APPLY,
        restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
        expectedVersion: 2,
        expiresAt: '2026-08-18T00:00:00.000Z',
        publicReasonCode: 'policy_violation',
        reasonCode: 'moderation_policy',
        reasonNote: 'Reviewed by moderation operator',
        correlationId: 'moderation-20260817-0001',
      }),
    ).toHaveLength(0);
  });

  it('rejects malformed operation, version and canonical reasons', () => {
    expect(
      validate({
        operation: 'BAN',
        restrictionType: UserRestrictionType.INDEFINITE_BAN,
        expectedVersion: -1,
        publicReasonCode: 'INVALID REASON',
        reasonCode: '$where',
        reasonNote: '',
      }).length,
    ).toBeGreaterThan(0);
  });
});
