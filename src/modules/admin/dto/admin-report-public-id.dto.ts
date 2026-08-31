import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { ADMIN_REPORT_PUBLIC_ID_PATTERN } from '../constants/admin-report-assignment.constants';

export class AdminReportPublicIdParamDto {
  @ApiProperty({ pattern: ADMIN_REPORT_PUBLIC_ID_PATTERN.source })
  @Matches(ADMIN_REPORT_PUBLIC_ID_PATTERN)
  publicId!: string;
}
