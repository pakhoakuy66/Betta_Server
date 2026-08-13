import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  ADMIN_PASSWORD_COMPLEXITY_PATTERN,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
} from '../constants/admin-account-recovery.constants';
import { ADMIN_TOTP_TOKEN_PATTERN } from '../constants/admin-mfa.constants';
import { ADMIN_BOOTSTRAP_GRANT_PATTERN } from '../constants/admin-bootstrap.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export class BeginAdminActivationDto {
  @ApiProperty({ pattern: ADMIN_PUBLIC_ID_PATTERN.source })
  @IsString()
  @Matches(ADMIN_PUBLIC_ID_PATTERN)
  adminPublicId!: string;

  @ApiProperty({ pattern: ADMIN_BOOTSTRAP_GRANT_PATTERN.source })
  @IsString()
  @Matches(ADMIN_BOOTSTRAP_GRANT_PATTERN)
  activationGrant!: string;
}

export class CompleteAdminActivationDto extends BeginAdminActivationDto {
  @ApiProperty({
    format: 'password',
    minLength: ADMIN_PASSWORD_MIN_LENGTH,
    maxLength: ADMIN_PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN_LENGTH)
  @MaxLength(ADMIN_PASSWORD_MAX_LENGTH)
  @Matches(ADMIN_PASSWORD_COMPLEXITY_PATTERN)
  newPassword!: string;

  @ApiProperty({
    format: 'password',
    minLength: ADMIN_PASSWORD_MIN_LENGTH,
    maxLength: ADMIN_PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN_LENGTH)
  @MaxLength(ADMIN_PASSWORD_MAX_LENGTH)
  confirmPassword!: string;

  @ApiProperty({ pattern: ADMIN_TOTP_TOKEN_PATTERN.source, example: '123456' })
  @IsString()
  @Matches(ADMIN_TOTP_TOKEN_PATTERN)
  totpToken!: string;
}
