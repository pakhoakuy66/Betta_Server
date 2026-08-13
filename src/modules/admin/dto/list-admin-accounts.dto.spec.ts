import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { ListAdminAccountsQueryDto } from './list-admin-accounts.dto';
import { AdminAccountPublicIdParamDto } from './admin-account-public-id.dto';

describe('ListAdminAccountsQueryDto', () => {
  it('applies bounded defaults and transforms allowlisted filters', async () => {
    const value = plainToInstance(ListAdminAccountsQueryDto, {
      page: '2',
      limit: '50',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      mfaStatus: AdminMfaStatus.ACTIVE,
      search: '  admin.owner  ',
    });

    await expect(validate(value)).resolves.toHaveLength(0);
    expect(value).toEqual(
      expect.objectContaining({
        page: 2,
        limit: 50,
        search: 'admin.owner',
      }),
    );

    const defaults = plainToInstance(ListAdminAccountsQueryDto, {});
    await expect(validate(defaults)).resolves.toHaveLength(0);
    expect(defaults.page).toBe(1);
    expect(defaults.limit).toBe(20);
  });

  it.each([
    { page: '0' },
    { page: '1.5' },
    { limit: '101' },
    { role: 'OWNER' },
    { status: 'DELETED' },
    { mfaStatus: 'ENABLED' },
    { search: 'a' },
    { search: '{"$ne":null}' },
    { search: 'admin owner' },
  ])('rejects malformed query %# before service access', async (source) => {
    const value = plainToInstance(ListAdminAccountsQueryDto, source);
    expect(await validate(value)).not.toHaveLength(0);
  });

  it('rejects non-allowlisted query properties through the application pipe', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    await expect(
      pipe.transform(
        { page: '1', sort: 'passwordHash' },
        { type: 'query', metatype: ListAdminAccountsQueryDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts only canonical Admin public IDs at the HTTP parameter boundary', async () => {
    await expect(
      validate(
        plainToInstance(AdminAccountPublicIdParamDto, {
          publicId: 'adm_23456789ABCD',
        }),
      ),
    ).resolves.toHaveLength(0);
    await expect(
      validate(
        plainToInstance(AdminAccountPublicIdParamDto, {
          publicId: '507f1f77bcf86cd799439011',
        }),
      ),
    ).resolves.not.toHaveLength(0);
  });
});
