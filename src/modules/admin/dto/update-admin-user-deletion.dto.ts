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
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
} from '../constants/admin-lifecycle.constants';
import {
  ADMIN_USER_DELETION_OPERATIONS,
  ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH,
  ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH,
  AdminUserDeletionOperation,
} from '../constants/admin-user-deletion.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateAdminUserDeletionDto {
  @ApiProperty({ enum: ADMIN_USER_DELETION_OPERATIONS })
  @IsIn(ADMIN_USER_DELETION_OPERATIONS)
  operation!: AdminUserDeletionOperation;

  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ pattern: ADMIN_LIFECYCLE_REASON_CODE_PATTERN.source })
  @Transform(trim)
  @IsString()
  @Matches(ADMIN_LIFECYCLE_REASON_CODE_PATTERN)
  reasonCode!: string;

  @ApiProperty({
    minLength: ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH,
    maxLength: ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH,
  })
  @Transform(trim)
  @IsString()
  @MinLength(ADMIN_USER_DELETION_REASON_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_USER_DELETION_REASON_NOTE_MAX_LENGTH)
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
