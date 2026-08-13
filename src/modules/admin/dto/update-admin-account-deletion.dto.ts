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
  ADMIN_ACCOUNT_DELETION_ACTION_VALUES,
  ADMIN_ACCOUNT_DELETION_REASON_NOTE_MAX_LENGTH,
  ADMIN_ACCOUNT_DELETION_REASON_NOTE_MIN_LENGTH,
  AdminAccountDeletionAction,
} from '../constants/admin-account-deletion.constants';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_SECURITY_GRANT_PATTERN,
} from '../constants/admin-account-recovery.constants';
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
} from '../constants/admin-lifecycle.constants';

export class IssueSuperAdminDeletionReauthDto {
  @ApiProperty({ enum: AdminAccountDeletionAction })
  @IsIn(ADMIN_ACCOUNT_DELETION_ACTION_VALUES)
  action!: AdminAccountDeletionAction;

  @ApiProperty({ format: 'password', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(ADMIN_PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ pattern: '^\\d{6}$', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/u)
  totpToken!: string;
}

export class UpdateAdminAccountDeletionDto {
  @ApiProperty({ enum: AdminAccountDeletionAction })
  @IsIn(ADMIN_ACCOUNT_DELETION_ACTION_VALUES)
  action!: AdminAccountDeletionAction;

  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ pattern: ADMIN_LIFECYCLE_REASON_CODE_PATTERN.source })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(ADMIN_LIFECYCLE_REASON_CODE_PATTERN)
  reasonCode!: string;

  @ApiProperty({
    minLength: ADMIN_ACCOUNT_DELETION_REASON_NOTE_MIN_LENGTH,
    maxLength: ADMIN_ACCOUNT_DELETION_REASON_NOTE_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(ADMIN_ACCOUNT_DELETION_REASON_NOTE_MIN_LENGTH)
  @MaxLength(ADMIN_ACCOUNT_DELETION_REASON_NOTE_MAX_LENGTH)
  reasonNote!: string;

  @ApiPropertyOptional({
    pattern: ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.source,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @Matches(ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN)
  correlationId?: string;

  @ApiPropertyOptional({
    description:
      'Bắt buộc và chỉ được dùng khi xóa mềm hoặc khôi phục SuperAdmin',
    pattern: ADMIN_SECURITY_GRANT_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(ADMIN_SECURITY_GRANT_PATTERN)
  reauthGrant?: string;
}
