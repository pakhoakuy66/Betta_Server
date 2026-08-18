import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { USER_STATUS } from '../../users/schemas/user.schema';
import {
  AdminUserDeletionFilter,
  AdminUserLoginLockFilter,
  AdminUserRestrictionFilter,
  AdminUserSort,
} from '../constants/admin-user-query.constants';
import { ListAdminUsersQueryDto } from './list-admin-users.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

describe('ListAdminUsersQueryDto', () => {
  it('applies bounded defaults and transforms allowlisted filters', async () => {
    const result = (await pipe.transform(
      {
        page: '2',
        limit: '100',
        status: USER_STATUS.ACTIVE,
        deletion: AdminUserDeletionFilter.ACTIVE,
        restriction: AdminUserRestrictionFilter.NONE,
        loginLock: AdminUserLoginLockFilter.UNLOCKED,
        sort: AdminUserSort.USERNAME_ASC,
        search: '  user.name  ',
      },
      { type: 'query', metatype: ListAdminUsersQueryDto },
    )) as ListAdminUsersQueryDto;

    expect(result).toMatchObject({
      page: 2,
      limit: 100,
      status: USER_STATUS.ACTIVE,
      deletion: AdminUserDeletionFilter.ACTIVE,
      restriction: AdminUserRestrictionFilter.NONE,
      loginLock: AdminUserLoginLockFilter.UNLOCKED,
      sort: AdminUserSort.USERNAME_ASC,
      search: 'user.name',
    });
  });

  it.each([
    { page: '0' },
    { limit: '101' },
    { status: 'root' },
    { deletion: 'ANY' },
    { restriction: 'SUSPENDED OR 1=1' },
    { loginLock: 'ALL' },
    { sort: '$where' },
    { search: '.*' },
    { search: '{"$ne":null}' },
    { search: '$where' },
    { unknown: 'field' },
  ])('rejects malformed or non-allowlisted query %#', async (input) => {
    await expect(
      pipe.transform(input, {
        type: 'query',
        metatype: ListAdminUsersQueryDto,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('keeps safe defaults for an empty query', () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, {});
    expect(dto).toMatchObject({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
    });
  });
});
