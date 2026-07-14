import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsUrl,
  Matches,
  ValidateIf,
  IsNotEmpty,
  IsInt,
  Max,
  Min,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
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

const INVALID_PUBLIC_ID_MARKER = '__invalid_public_id__';

const normalizePublicIdItem = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();

  return INVALID_PUBLIC_ID_MARKER;
};

const normalizePublicIdRawValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value as unknown[];
  }

  return [value];
};

const normalizePublicIdList = (value: unknown): string[] => {
  if (value === undefined || value === null || value === '') return [];

  const values: string[] = [];

  normalizePublicIdRawValues(value).forEach((item) => {
    if (typeof item === 'string') {
      values.push(...item.split(','));
      return;
    }

    values.push(normalizePublicIdItem(item));
  });

  return values.map(normalizePublicIdItem).filter((item) => item.length > 0);
};

export class SuggestUsersQueryDto {
  @ApiPropertyOptional({
    example: 10,
    description: 'Số lượng user gợi ý cần lấy, tối đa 30',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit phải là số nguyên' })
  @Min(1, { message: 'Limit tối thiểu là 1' })
  @Max(30, { message: 'Limit tối đa là 30' })
  limit: number = 10;

  @ApiPropertyOptional({
    example: 'usr_abc123,usr_def456',
    description:
      'Danh sách publicId đã hiển thị trong phiên Feed hiện tại để tránh trùng gợi ý',
  })
  @Transform(({ value }: TransformFnParams) => normalizePublicIdList(value))
  @IsOptional()
  @IsArray({ message: 'excludePublicIds phải là danh sách publicId' })
  @ArrayMaxSize(100, {
    message: 'excludePublicIds không được vượt quá 100 phần tử',
  })
  @Matches(/^usr_[A-Za-z0-9_-]{6,40}$/, {
    each: true,
    message: 'excludePublicIds chứa publicId không hợp lệ',
  })
  excludePublicIds: string[] = [];
}

export class DeleteMyAccountDto {
  @ApiProperty({
    example: 'MyPassword@123',
    description: 'Mật khẩu hiện tại để xác nhận xóa tài khoản',
  })
  @IsString({ message: 'Mật khẩu xác nhận phải là chuỗi' })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu để xác nhận xóa tài khoản' })
  @Matches(/\S/, {
    message: 'Vui lòng nhập mật khẩu để xác nhận xóa tài khoản',
  })
  @MaxLength(128, {
    message: 'Mật khẩu xác nhận không được vượt quá 128 ký tự',
  })
  currentPassword!: string;
}

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean({ message: 'Trạng thái thông báo phải là boolean' })
  enabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean({ message: 'Trạng thái thông báo follow phải là boolean' })
  follow?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean({ message: 'Trạng thái thông báo reaction phải là boolean' })
  reaction?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean({ message: 'Trạng thái thông báo recap phải là boolean' })
  recap?: boolean;
}
