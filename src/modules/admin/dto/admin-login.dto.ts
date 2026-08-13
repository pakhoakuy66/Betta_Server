import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ADMIN_AUTH_MAX_PASSWORD_LENGTH } from '../constants/admin-auth.constants';

export class AdminLoginDto {
  @ApiProperty({ format: 'email', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

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
