import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
} from '../constants/admin-lifecycle.constants';
import {
  ADMIN_USER_RESTRICTION_OPERATIONS,
  ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH,
  ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH,
  ADMIN_USER_RESTRICTION_TYPES,
  AdminUserRestrictionOperation,
} from '../constants/admin-user-restriction.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateAdminUserRestrictionDto {
  @ApiProperty({ enum: ADMIN_USER_RESTRICTION_OPERATIONS })
  @IsIn(ADMIN_USER_RESTRICTION_OPERATIONS)
  operation!: AdminUserRestrictionOperation;

  @ApiProperty({ enum: ADMIN_USER_RESTRICTION_TYPES })
  @IsIn(ADMIN_USER_RESTRICTION_TYPES)
  restrictionType!: UserRestrictionType;

  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf(
    (dto: UpdateAdminUserRestrictionDto) =>
      dto.operation === AdminUserRestrictionOperation.APPLY &&
      dto.restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION,
  )
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  expiresAt?: string;

  @ApiPropertyOptional({
    pattern: USER_RESTRICTION_PUBLIC_REASON_PATTERN.source,
  })
  @ValidateIf(
    (dto: UpdateAdminUserRestrictionDto) =>
      dto.operation === AdminUserRestrictionOperation.APPLY,
  )
  @Transform(trim)
  @IsString()
  @Matches(USER_RESTRICTION_PUBLIC_REASON_PATTERN)
  publicReasonCode?: string;

  @ApiProperty({ pattern: ADMIN_LIFECYCLE_REASON_CODE_PATTERN.source })
  @Transform(trim)
  @IsString()
  @Matches(ADMIN_LIFECYCLE_REASON_CODE_PATTERN)
  reasonCode!: string;

  @ApiProperty({
    minLength: ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH,
    maxLength: ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH,
  })
  @Transform(trim)
  @IsString()
  @MinLength(ADMIN_USER_RESTRICTION_REASON_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_USER_RESTRICTION_REASON_NOTE_MAX_LENGTH)
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
