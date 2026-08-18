import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { USER_STATUS, type UserStatus } from '../../users/schemas/user.schema';
import {
  ADMIN_USER_QUERY_DEFAULT_LIMIT,
  ADMIN_USER_QUERY_DEFAULT_PAGE,
  ADMIN_USER_QUERY_MAX_LIMIT,
  ADMIN_USER_QUERY_MAX_PAGE,
  ADMIN_USER_QUERY_SEARCH_PATTERN,
  AdminUserDeletionFilter,
  AdminUserLoginLockFilter,
  AdminUserRestrictionFilter,
  AdminUserSort,
} from '../constants/admin-user-query.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ListAdminUsersQueryDto {
  @ApiPropertyOptional({ default: ADMIN_USER_QUERY_DEFAULT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_USER_QUERY_MAX_PAGE)
  page = ADMIN_USER_QUERY_DEFAULT_PAGE;

  @ApiPropertyOptional({
    default: ADMIN_USER_QUERY_DEFAULT_LIMIT,
    maximum: ADMIN_USER_QUERY_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_USER_QUERY_MAX_LIMIT)
  limit = ADMIN_USER_QUERY_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: USER_STATUS })
  @IsOptional()
  @IsEnum(USER_STATUS)
  status?: UserStatus;

  @ApiPropertyOptional({ enum: AdminUserDeletionFilter })
  @IsOptional()
  @IsEnum(AdminUserDeletionFilter)
  deletion?: AdminUserDeletionFilter;

  @ApiPropertyOptional({ enum: AdminUserRestrictionFilter })
  @IsOptional()
  @IsEnum(AdminUserRestrictionFilter)
  restriction?: AdminUserRestrictionFilter;

  @ApiPropertyOptional({ enum: AdminUserLoginLockFilter })
  @IsOptional()
  @IsEnum(AdminUserLoginLockFilter)
  loginLock?: AdminUserLoginLockFilter;

  @ApiPropertyOptional({
    enum: AdminUserSort,
    default: AdminUserSort.CREATED_AT_DESC,
  })
  @IsOptional()
  @IsEnum(AdminUserSort)
  sort = AdminUserSort.CREATED_AT_DESC;

  @ApiPropertyOptional({
    description: 'Public ID, username, email hoặc số điện thoại chính xác',
    minLength: 1,
    maxLength: 254,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(ADMIN_USER_QUERY_SEARCH_PATTERN)
  search?: string;
}
