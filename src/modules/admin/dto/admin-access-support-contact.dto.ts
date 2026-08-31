import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/access-support.constants';
import { ADMIN_AUTH_MAX_PASSWORD_LENGTH } from '../constants/admin-auth.constants';
import { ADMIN_SECURITY_GRANT_PATTERN } from '../constants/admin-account-recovery.constants';
import { ADMIN_AUDIT_CORRELATION_ID_PATTERN } from '../constants/admin-audit.constants';
import { ADMIN_ACCESS_SUPPORT_CONTACT_REASON_PATTERN } from '../constants/admin-access-support-contact.constants';

export class AdminAccessSupportContactParamDto {
  @ApiProperty({ pattern: ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN.source })
  @Matches(ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN)
  publicId!: string;
}

export class IssueAdminAccessSupportContactReauthDto {
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

export class RevealAdminAccessSupportContactDto {
  @ApiProperty({ pattern: ADMIN_SECURITY_GRANT_PATTERN.source })
  @IsString()
  @Matches(ADMIN_SECURITY_GRANT_PATTERN)
  reauthGrant!: string;

  @ApiProperty({
    description:
      'Reason code nghiệp vụ, không chứa contact hoặc nội dung nhạy cảm',
    pattern: ADMIN_ACCESS_SUPPORT_CONTACT_REASON_PATTERN.source,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(ADMIN_ACCESS_SUPPORT_CONTACT_REASON_PATTERN)
  reason!: string;

  @ApiPropertyOptional({ pattern: ADMIN_AUDIT_CORRELATION_ID_PATTERN.source })
  @IsOptional()
  @IsString()
  @Matches(ADMIN_AUDIT_CORRELATION_ID_PATTERN)
  correlationId?: string;
}
