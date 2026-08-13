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
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCOUNT_QUERY_DEFAULT_LIMIT,
  ADMIN_ACCOUNT_QUERY_DEFAULT_PAGE,
  ADMIN_ACCOUNT_QUERY_MAX_LIMIT,
  ADMIN_ACCOUNT_QUERY_MAX_PAGE,
  ADMIN_ACCOUNT_QUERY_SEARCH_PATTERN,
} from '../constants/admin-account-query.constants';

export class ListAdminAccountsQueryDto {
  @ApiPropertyOptional({ default: ADMIN_ACCOUNT_QUERY_DEFAULT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_ACCOUNT_QUERY_MAX_PAGE)
  page = ADMIN_ACCOUNT_QUERY_DEFAULT_PAGE;

  @ApiPropertyOptional({
    default: ADMIN_ACCOUNT_QUERY_DEFAULT_LIMIT,
    maximum: ADMIN_ACCOUNT_QUERY_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_ACCOUNT_QUERY_MAX_LIMIT)
  limit = ADMIN_ACCOUNT_QUERY_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: AdminRole })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

  @ApiPropertyOptional({ enum: AdminAccountStatus })
  @IsOptional()
  @IsEnum(AdminAccountStatus)
  status?: AdminAccountStatus;

  @ApiPropertyOptional({ enum: AdminMfaStatus })
  @IsOptional()
  @IsEnum(AdminMfaStatus)
  mfaStatus?: AdminMfaStatus;

  @ApiPropertyOptional({
    description: 'Email, username hoặc Admin public ID chính xác',
    minLength: 2,
    maxLength: 254,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(ADMIN_ACCOUNT_QUERY_SEARCH_PATTERN)
  search?: string;
}
