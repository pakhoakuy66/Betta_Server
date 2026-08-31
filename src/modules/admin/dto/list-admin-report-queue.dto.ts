import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ReportQueuePriority } from '../../reports/constants/report-queue.constants';
import {
  ADMIN_REPORT_QUEUE_DEFAULT_LIMIT,
  ADMIN_REPORT_QUEUE_DEFAULT_PAGE,
  ADMIN_REPORT_QUEUE_MAX_LIMIT,
  ADMIN_REPORT_QUEUE_MAX_PAGE,
  ADMIN_REPORT_QUEUE_REASON_CODES,
  ADMIN_REPORT_QUEUE_UNASSIGNED,
  AdminReportQueueSlaFilter,
  AdminReportQueueSort,
  AdminReportQueueStatus,
  AdminReportQueueType,
} from '../constants/admin-report-queue.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const ASSIGNEE_PATTERN = new RegExp(
  `^(?:${ADMIN_REPORT_QUEUE_UNASSIGNED}|${ADMIN_PUBLIC_ID_PATTERN.source.slice(1, -1)})$`,
);
const ISO_DATE_TIME_WITH_ZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/u;

export class ListAdminReportQueueDto {
  @ApiPropertyOptional({ default: ADMIN_REPORT_QUEUE_DEFAULT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_REPORT_QUEUE_MAX_PAGE)
  page = ADMIN_REPORT_QUEUE_DEFAULT_PAGE;

  @ApiPropertyOptional({
    default: ADMIN_REPORT_QUEUE_DEFAULT_LIMIT,
    maximum: ADMIN_REPORT_QUEUE_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_REPORT_QUEUE_MAX_LIMIT)
  limit = ADMIN_REPORT_QUEUE_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: AdminReportQueueType })
  @IsOptional()
  @IsEnum(AdminReportQueueType)
  type?: AdminReportQueueType;

  @ApiPropertyOptional({ enum: AdminReportQueueStatus })
  @IsOptional()
  @IsEnum(AdminReportQueueStatus)
  status?: AdminReportQueueStatus;

  @ApiPropertyOptional({ enum: ADMIN_REPORT_QUEUE_REASON_CODES })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsIn(ADMIN_REPORT_QUEUE_REASON_CODES)
  reason?: string;

  @ApiPropertyOptional({ enum: ReportQueuePriority })
  @IsOptional()
  @IsEnum(ReportQueuePriority)
  priority?: ReportQueuePriority;

  @ApiPropertyOptional({
    description: 'Admin public ID hoặc UNASSIGNED',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(ASSIGNEE_PATTERN)
  assignee?: string;

  @ApiPropertyOptional({ enum: AdminReportQueueSlaFilter })
  @IsOptional()
  @IsEnum(AdminReportQueueSlaFilter)
  sla?: AdminReportQueueSlaFilter;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Transform(trim)
  @IsISO8601({ strict: true })
  @Matches(ISO_DATE_TIME_WITH_ZONE_PATTERN, {
    message: 'createdFrom phải có timezone UTC hoặc offset',
  })
  createdFrom?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Transform(trim)
  @IsISO8601({ strict: true })
  @Matches(ISO_DATE_TIME_WITH_ZONE_PATTERN, {
    message: 'createdTo phải có timezone UTC hoặc offset',
  })
  createdTo?: string;

  @ApiPropertyOptional({
    enum: AdminReportQueueSort,
    default: AdminReportQueueSort.CREATED_AT_DESC,
  })
  @IsOptional()
  @IsEnum(AdminReportQueueSort)
  sort = AdminReportQueueSort.CREATED_AT_DESC;
}
