import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ADMIN_MODERATION_HISTORY_DEFAULT_LIMIT,
  ADMIN_MODERATION_HISTORY_DEFAULT_PAGE,
  ADMIN_MODERATION_HISTORY_MAX_LIMIT,
  ADMIN_MODERATION_HISTORY_MAX_PAGE,
} from '../constants/admin-moderation-history.constants';

export class ListAdminModerationHistoryQueryDto {
  @ApiPropertyOptional({
    default: ADMIN_MODERATION_HISTORY_DEFAULT_PAGE,
    minimum: 1,
    maximum: ADMIN_MODERATION_HISTORY_MAX_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_MODERATION_HISTORY_MAX_PAGE)
  page = ADMIN_MODERATION_HISTORY_DEFAULT_PAGE;

  @ApiPropertyOptional({
    default: ADMIN_MODERATION_HISTORY_DEFAULT_LIMIT,
    minimum: 1,
    maximum: ADMIN_MODERATION_HISTORY_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_MODERATION_HISTORY_MAX_LIMIT)
  limit = ADMIN_MODERATION_HISTORY_DEFAULT_LIMIT;
}
