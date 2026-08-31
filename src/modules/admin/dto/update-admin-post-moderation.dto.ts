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
  ADMIN_POST_HIDE_REASON_CODES,
  ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH,
  ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH,
  ADMIN_POST_RESTORE_REASON_CODES,
  ADMIN_POST_TERMINAL_DELETE_REASON_CODES,
} from '../constants/admin-post-moderation.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

abstract class UpdateAdminPostModerationBaseDto {
  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedModerationVersion!: number;

  @ApiPropertyOptional({
    minLength: ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH,
    maxLength: ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH)
  reasonNote?: string;

  @ApiPropertyOptional({
    pattern: ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.source,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN)
  correlationId?: string;
}

export class HideAdminPostDto extends UpdateAdminPostModerationBaseDto {
  @ApiProperty({ enum: ADMIN_POST_HIDE_REASON_CODES })
  @Transform(trim)
  @IsString()
  @IsIn(ADMIN_POST_HIDE_REASON_CODES)
  reasonCode!: string;
}

export class RestoreAdminPostDto extends UpdateAdminPostModerationBaseDto {
  @ApiProperty({ enum: ADMIN_POST_RESTORE_REASON_CODES })
  @Transform(trim)
  @IsString()
  @IsIn(ADMIN_POST_RESTORE_REASON_CODES)
  reasonCode!: string;
}

export class TerminalDeleteAdminPostDto extends UpdateAdminPostModerationBaseDto {
  @ApiProperty({ enum: ADMIN_POST_TERMINAL_DELETE_REASON_CODES })
  @Transform(trim)
  @IsString()
  @IsIn(ADMIN_POST_TERMINAL_DELETE_REASON_CODES)
  reasonCode!: string;
}
