import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  Length,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'khoaanhphan',
    description: 'Tên tài khoản duy nhất',
  })
  @IsNotEmpty({ message: 'Tên tài khoản không được bỏ trống' })
  @IsString()
  username!: string;

  @ApiProperty({ example: 'Phan Anh Khoa', description: 'Họ và tên đầy đủ' })
  @IsNotEmpty({ message: 'Tên người dùng không được bỏ trống' })
  @IsString()
  fullname!: string;

  @ApiProperty({ example: '0901234567', description: 'Số điện thoại liên lạc' })
  @IsNotEmpty({ message: 'Số điện thoại không được bỏ trống' })
  @IsString()
  @MinLength(10, { message: 'Số điện thoại ở Việt Nam phải có 10 số' })
  @MaxLength(11, { message: 'Định dạng số điện thoại bị dư' })
  phone!: string;

  @ApiProperty({ example: 'khoa@example.com', description: 'Email đăng ký' })
  @IsNotEmpty({ message: 'Email không được bỏ trống' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'Password123@',
    description: 'Mật khẩu (bao gồm hoa, thường, số, ký tự đặc biệt)',
  })
  @IsNotEmpty({ message: 'Mật khẩu không được bỏ trống' })
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'Mật khẩu quá yếu (phải bao gồm chữ hoa, chữ thường, số và ký tự đặc biệt)',
  })
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'khoa@example.com' })
  @IsNotEmpty({ message: 'Email không được bỏ trống' })
  @IsEmail({}, { message: 'Email hoặc mật khẩu không chính xác' })
  email!: string;

  @ApiProperty({ example: 'Password123@' })
  @IsNotEmpty({ message: 'Mật khẩu không được bỏ trống' })
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'khoa@example.com' })
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'khoa@example.com' })
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456', description: 'Mã OTP gồm 6 chữ số' })
  @IsNotEmpty({ message: 'Vui lòng nhập mã OTP' })
  @IsString()
  @Length(6, 6, { message: 'OTP phải đủ 6 chữ số' })
  otp!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'khoa@example.com' })
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsNotEmpty({ message: 'Vui lòng nhập mã OTP' })
  @IsString()
  otp!: string;

  @ApiProperty({ example: 'NewPassword123@' })
  @IsNotEmpty()
  @IsString()
  @MinLength(6, {
    message: 'Mật khẩu phải tối thiểu 6 ký tự.',
  })
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'Mật khẩu quá yếu (phải bao gồm chữ hoa, chữ thường, số và ký tự đặc biệt)',
  })
  newPassword!: string;
}
