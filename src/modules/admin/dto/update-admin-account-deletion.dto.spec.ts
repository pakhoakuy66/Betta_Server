import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AdminAccountDeletionAction } from '../constants/admin-account-deletion.constants';
import { UpdateAdminAccountDeletionDto } from './update-admin-account-deletion.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const valid = () => ({
  action: AdminAccountDeletionAction.SOFT_DELETE,
  expectedVersion: '3',
  reasonCode: 'security_offboarding',
  reasonNote: 'Approved administrative offboarding',
  correlationId: 'admin-delete-20260813-0001',
});

describe('UpdateAdminAccountDeletionDto', () => {
  it('normalizes a bounded delete request', async () => {
    await expect(
      pipe.transform(valid(), {
        type: 'body',
        metatype: UpdateAdminAccountDeletionDto,
      }),
    ).resolves.toMatchObject({
      action: AdminAccountDeletionAction.SOFT_DELETE,
      expectedVersion: 3,
      reasonCode: 'security_offboarding',
    });
  });

  it.each([
    { ...valid(), action: 'HARD_DELETE' },
    { ...valid(), expectedVersion: -1 },
    { ...valid(), expectedVersion: '1.5' },
    { ...valid(), reasonCode: 'INVALID REASON' },
    { ...valid(), reasonNote: 'x' },
    { ...valid(), correlationId: 'short' },
    { ...valid(), reauthGrant: 'not-canonical' },
    { ...valid(), role: 'SUPER_ADMIN' },
  ])('rejects malformed or injected payload %#', async (input) => {
    await expect(
      pipe.transform(input, {
        type: 'body',
        metatype: UpdateAdminAccountDeletionDto,
      }),
    ).rejects.toBeDefined();
  });
});
