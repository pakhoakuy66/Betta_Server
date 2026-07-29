import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../constants/password-policy';

export class UnlinkGoogleOAuthAccountDto {
  @ApiProperty({
    example: 'CurrentPassword123.',
    description: 'Mật khẩu hiện tại dùng để xác nhận thao tác bảo mật',
    format: 'password',
    maxLength: PASSWORD_MAX_LENGTH,
    writeOnly: true,
  })
  @IsString({ message: 'Mật khẩu hiện tại phải là chuỗi' })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu hiện tại' })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `Mật khẩu không được vượt quá ${PASSWORD_MAX_LENGTH} ký tự`,
  })
  currentPassword!: string;
}
