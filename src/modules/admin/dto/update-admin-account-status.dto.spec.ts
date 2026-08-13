import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminAccountStatus } from '../constants/admin-account.constants';
import {
  IssueSuperAdminStatusReauthDto,
  UpdateAdminAccountStatusDto,
} from './update-admin-account-status.dto';

describe('Admin account status DTOs', () => {
  it('accepts the finite CAS status contract', async () => {
    const value = plainToInstance(UpdateAdminAccountStatusDto, {
      status: AdminAccountStatus.LOCKED,
      expectedVersion: '4',
      reasonCode: 'security_review',
      reasonNote: '  Suspicious privileged activity  ',
      correlationId: 'admin-lock-20260813-0001',
    });

    await expect(validate(value)).resolves.toHaveLength(0);
    expect(value.expectedVersion).toBe(4);
    expect(value.reasonNote).toBe('Suspicious privileged activity');
  });

  it.each([
    { status: AdminAccountStatus.PENDING_ACTIVATION },
    { status: AdminAccountStatus.LOCKED, expectedVersion: -1 },
    { status: AdminAccountStatus.LOCKED, expectedVersion: 1.5 },
    { status: AdminAccountStatus.LOCKED, reasonCode: '$where' },
    { status: AdminAccountStatus.LOCKED, reasonNote: 'x' },
    { status: AdminAccountStatus.LOCKED, reauthGrant: 'raw-secret' },
  ])('rejects malformed mutation %#', async (override) => {
    const value = plainToInstance(
      UpdateAdminAccountStatusDto,
      Object.assign(
        {
          status: AdminAccountStatus.LOCKED,
          expectedVersion: 1,
          reasonCode: 'security_review',
          reasonNote: 'Approved security response',
        },
        override,
      ),
    );

    expect(await validate(value)).not.toHaveLength(0);
  });

  it('validates a purpose-selecting SuperAdmin re-auth request', async () => {
    const value = plainToInstance(IssueSuperAdminStatusReauthDto, {
      status: AdminAccountStatus.ACTIVE,
      password: 'Correct Horse Battery Staple',
      totpToken: '123456',
    });

    await expect(validate(value)).resolves.toHaveLength(0);
  });

  it('rejects property injection through the application validation pipe', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    await expect(
      pipe.transform(
        {
          status: AdminAccountStatus.LOCKED,
          expectedVersion: 1,
          reasonCode: 'security_review',
          reasonNote: 'Approved security response',
          role: 'SUPER_ADMIN',
        },
        { type: 'body', metatype: UpdateAdminAccountStatusDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
