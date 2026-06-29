import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsUrl,
  Matches,
  ValidateIf,
  IsInt,
  Max,
  Min,
} from 'class-validator';

const trimString = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'bibi.real_01',
    description: 'Username 1-30 ký tự, chỉ gồm chữ, số, dấu chấm và gạch dưới',
  })
  @Transform(({ value }: TransformFnParams) => trimString(value))
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Username không được để trống' })
  @MaxLength(30, { message: 'Username không được vượt quá 30 ký tự' })
  @Matches(/^[A-Za-z0-9._]+$/, {
    message: 'Username chỉ được chứa chữ, số, dấu chấm và gạch dưới',
  })
  username?: string;

  @ApiPropertyOptional({
    example: 'Lập trình viên dạo...',
    description: 'Tiểu sử tối đa 150 ký tự',
  })
  @Transform(({ value }: TransformFnParams) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(150, { message: 'Bio tối đa 150 ký tự' })
  bio?: string;

  @ApiPropertyOptional({
    example: 'https://github.com/nguyenvana',
    description: 'Liên kết cá nhân hợp lệ. Gửi chuỗi rỗng để xóa liên kết.',
  })
  @Transform(({ value }: TransformFnParams) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Link không được vượt quá 200 ký tự' })
  @ValidateIf((_, value) => value !== '')
  @IsUrl(
    {
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'Link không hợp lệ' },
  )
  link?: string;
}

export class SearchUsersQueryDto {
  @ApiPropertyOptional({
    example: 'ak',
    description: 'Từ khóa tìm kiếm username, tối thiểu 2 ký tự',
  })
  @Transform(({ value }: TransformFnParams) => trimString(value))
  @IsString()
  @MinLength(2, { message: 'Từ khóa tìm kiếm phải có ít nhất 2 ký tự' })
  @MaxLength(30, { message: 'Từ khóa tìm kiếm không được vượt quá 30 ký tự' })
  q!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Trang kết quả tìm kiếm, bắt đầu từ 1',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Page phải là số nguyên' })
  @Min(1, { message: 'Page tối thiểu là 1' })
  page: number = 1;

  @ApiPropertyOptional({
    example: 10,
    description: 'Số lượng kết quả mỗi trang, tối đa 20',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit phải là số nguyên' })
  @Min(1, { message: 'Limit tối thiểu là 1' })
  @Max(20, { message: 'Limit tối đa là 20' })
  limit: number = 10;
}
