import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
  ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH,
  ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH,
  ADMIN_REPORT_ASSIGNMENT_OPERATIONS,
  AdminReportAssignmentOperation,
} from '../constants/admin-report-assignment.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateAdminReportAssignmentDto {
  @ApiProperty({ enum: ADMIN_REPORT_ASSIGNMENT_OPERATIONS })
  @IsIn(ADMIN_REPORT_ASSIGNMENT_OPERATIONS)
  operation!: AdminReportAssignmentOperation;

  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiPropertyOptional({ pattern: ADMIN_PUBLIC_ID_PATTERN.source })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(ADMIN_PUBLIC_ID_PATTERN)
  assigneePublicId?: string;

  @ApiPropertyOptional({
    minLength: ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH,
    maxLength: ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH)
  adminNote?: string;

  @ApiPropertyOptional({
    pattern: ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.source,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN)
  correlationId?: string;
}
