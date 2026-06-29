import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePostDto {
  @ApiPropertyOptional({
    example: 'Hôm nay mình thấy rất vui...',
    maxLength: 2500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2500, {
    message: 'Nội dung bài viết không được vượt quá 2500 ký tự',
  })
  content?: string;
}
