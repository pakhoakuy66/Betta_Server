import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trimStringValue = ({ value }: { value: unknown }): unknown => {
  return typeof value === 'string' ? value.trim() : value;
};

export class ReportIssueDto {
  @ApiProperty({
    example: 'Tôi không thể mở trang thông báo sau khi đăng nhập.',
    description: 'Nội dung mô tả sự cố hệ thống',
  })
  @Transform(trimStringValue)
  @IsString({ message: 'Nội dung báo cáo phải là chuỗi' })
  @MinLength(10, {
    message: 'Nội dung báo cáo phải có ít nhất 10 ký tự',
  })
  @MaxLength(2000, {
    message: 'Nội dung báo cáo không được vượt quá 2000 ký tự',
  })
  description!: string;
}
