import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, IsUrl } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'bibi_real' })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Username không được vượt quá 50 ký tự' })
  username?: string;

  @ApiPropertyOptional({ example: 'Lập trình viên dạo...' })
  @IsOptional()
  @IsString()
  @MaxLength(150, { message: 'Bio tối đa 150 ký tự' })
  bio?: string;

  @ApiPropertyOptional({ example: 'https://github.com/nguyenvana' })
  @IsOptional()
  @IsUrl({}, { message: 'Link không hợp lệ' })
  link?: string;

  @ApiPropertyOptional({ example: 'https://res.cloudinary.com/.../avatar.jpg' })
  @IsOptional()
  @IsString()
  avatar?: string;

  @ApiPropertyOptional({ example: 'user_1_bibjpn' })
  @IsOptional()
  @IsString()
  avatarId?: string;
}
