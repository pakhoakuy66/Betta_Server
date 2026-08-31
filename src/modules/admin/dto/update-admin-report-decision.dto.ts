import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN } from '../constants/admin-lifecycle.constants';
import {
  ADMIN_REPORT_DECISION_ACTION_REASON_CODES,
  ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH,
  ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH,
  ADMIN_REPORT_DECISION_PUBLIC_REASON_CODES,
  ADMIN_REPORT_DECISION_REASON_CODES,
  ADMIN_REPORT_DECISIONS,
  ADMIN_REPORT_TARGET_ACTIONS,
  AdminReportDecision,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateAdminReportDecisionDto {
  @ApiProperty({ enum: ADMIN_REPORT_DECISIONS })
  @IsIn(ADMIN_REPORT_DECISIONS)
  decision!: AdminReportDecision;

  @ApiProperty({ enum: ADMIN_REPORT_TARGET_ACTIONS })
  @IsIn(ADMIN_REPORT_TARGET_ACTIONS)
  targetAction!: AdminReportTargetAction;

  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedReportVersion!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedTargetVersion?: number;

  @ApiProperty({ enum: ADMIN_REPORT_DECISION_REASON_CODES })
  @Transform(trim)
  @IsString()
  @IsIn(ADMIN_REPORT_DECISION_REASON_CODES)
  reasonCode!: string;

  @ApiPropertyOptional({ enum: ADMIN_REPORT_DECISION_ACTION_REASON_CODES })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsIn(ADMIN_REPORT_DECISION_ACTION_REASON_CODES)
  actionReasonCode?: string;

  @ApiPropertyOptional({ enum: ADMIN_REPORT_DECISION_PUBLIC_REASON_CODES })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsIn(ADMIN_REPORT_DECISION_PUBLIC_REASON_CODES)
  publicReasonCode?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string;

  @ApiProperty({
    minLength: ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH,
    maxLength: ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH,
  })
  @Transform(trim)
  @IsString()
  @MinLength(ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH)
  reasonNote!: string;

  @ApiPropertyOptional({
    pattern: ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.source,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN)
  correlationId?: string;
}
