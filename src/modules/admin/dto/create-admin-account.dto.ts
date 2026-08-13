import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ADMIN_AUTH_MAX_PASSWORD_LENGTH } from '../constants/admin-auth.constants';
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
  ADMIN_LIFECYCLE_USERNAME_PATTERN,
} from '../constants/admin-lifecycle.constants';
import { ADMIN_SECURITY_GRANT_PATTERN } from '../constants/admin-account-recovery.constants';

export class IssueAdminCreateReauthDto {
  @ApiProperty({ format: 'password', minLength: 1, maxLength: 1024 })
  @IsString()
  @MinLength(1)
  @MaxLength(ADMIN_AUTH_MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ pattern: '^\\d{6}$', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/u)
  totpToken!: string;
}

export class CreateAdminAccountDto {
  @ApiProperty({ format: 'email', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 3, maxLength: 40 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(ADMIN_LIFECYCLE_USERNAME_PATTERN)
  username!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({ pattern: ADMIN_SECURITY_GRANT_PATTERN.source })
  @IsString()
  @Matches(ADMIN_SECURITY_GRANT_PATTERN)
  reauthGrant!: string;

  @ApiProperty({ pattern: ADMIN_LIFECYCLE_REASON_CODE_PATTERN.source })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(ADMIN_LIFECYCLE_REASON_CODE_PATTERN)
  reasonCode!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reasonNote?: string;

  @ApiPropertyOptional({
    pattern: ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN)
  correlationId?: string;
}
