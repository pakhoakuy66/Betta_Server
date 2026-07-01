import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ReportReasonGroup } from '../schemas/report.schema';

const trimStringValue = ({ value }: { value: unknown }): unknown => {
  return typeof value === 'string' ? value.trim() : value;
};

export class ReportPostDto {
  @ApiPropertyOptional({
    enum: ReportReasonGroup,
    example: ReportReasonGroup.VIOLATION_CONTENT,
    description: 'Nhóm lý do báo cáo. Nếu không gửi, backend dùng mặc định.',
  })
  @IsOptional()
  @IsEnum(ReportReasonGroup, { message: 'Nhóm lý do báo cáo không hợp lệ' })
  reasonGroup?: ReportReasonGroup;

  @ApiProperty({
    example: 'Nội dung nhạy cảm hoặc gây hại',
    description: 'Lý do báo cáo bài viết',
  })
  @Transform(trimStringValue)
  @IsString()
  @MinLength(2, { message: 'Lý do báo cáo phải có ít nhất 2 ký tự' })
  @MaxLength(200, { message: 'Lý do báo cáo không được vượt quá 200 ký tự' })
  reasonDetail!: string;

  @ApiPropertyOptional({
    example: 'Bài viết có nội dung công kích cá nhân.',
    description: 'Mô tả bổ sung của người báo cáo',
  })
  @Transform(trimStringValue)
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Mô tả không được vượt quá 1000 ký tự' })
  description?: string;
}
