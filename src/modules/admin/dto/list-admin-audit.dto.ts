import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export class ListAdminAuditQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ADMIN_PUBLIC_ID_PATTERN)
  actorPublicId?: string;

  @ApiPropertyOptional({ enum: AdminAuditAction })
  @IsOptional()
  @IsEnum(AdminAuditAction)
  action?: AdminAuditAction;

  @ApiPropertyOptional({ enum: AdminAuditTargetType })
  @IsOptional()
  @IsEnum(AdminAuditTargetType)
  targetType?: AdminAuditTargetType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN)
  targetPublicId?: string;

  @ApiPropertyOptional({ enum: AdminAuditOutcome })
  @IsOptional()
  @IsEnum(AdminAuditOutcome)
  outcome?: AdminAuditOutcome;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
