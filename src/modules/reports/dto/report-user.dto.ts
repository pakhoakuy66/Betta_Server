import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { REPORT_USER_REASON_CODES } from '../../../common/moderation/moderation-reason.constants';
import { ReportReasonGroup } from '../schemas/report.schema';

const trimStringValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ReportUserDto {
  @ApiPropertyOptional({
    enum: REPORT_USER_REASON_CODES,
    description: 'Canonical reason code. Ưu tiên field này cho mọi Client mới.',
  })
  @Transform(trimStringValue)
  @IsOptional()
  @IsString()
  @IsIn(REPORT_USER_REASON_CODES)
  reasonCode?: string;

  @ApiPropertyOptional({
    enum: ReportReasonGroup,
    deprecated: true,
    description:
      'Compatibility field cho Client cũ; chỉ chấp nhận cùng nhãn SRS allowlist.',
  })
  @IsOptional()
  @IsIn(Object.values(ReportReasonGroup))
  reasonGroup?: ReportReasonGroup;

  @ApiPropertyOptional({ deprecated: true, maxLength: 200 })
  @Transform(trimStringValue)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reasonDetail?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Transform(trimStringValue)
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Mô tả không được vượt quá 1000 ký tự' })
  description?: string;
}
