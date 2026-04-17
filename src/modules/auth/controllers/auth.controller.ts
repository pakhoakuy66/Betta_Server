import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../services/auth.service';
import {
  RegisterDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
} from '../dto/auth.dto';
import { LoginDto } from '../dto/auth.dto';

@ApiTags('Authentication') // Gom nhóm các API này vào mục Authentication trên Swagger
@Controller('auth') // API sẽ gọi vào: http://localhost:5000/api/v1/auth
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: 'Đăng ký tài khoản mới' })
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @ApiOperation({ summary: 'Đăng nhập hệ thống' })
  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @ApiOperation({ summary: 'Yêu cầu gửi mã OTP quên mật khẩu' })
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({ summary: 'Xác thực mã OTP' })
  @Post('verify-otp')
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @ApiOperation({ summary: 'Đặt lại mật khẩu mới bằng OTP' })
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @ApiOperation({ summary: 'Đăng xuất hệ thống' })
  @ApiBearerAuth('access-token') // Để hiện nút nhập Token trên Swagger
  @UseGuards(AuthGuard('jwt'))
  @Post('logout')
  async logout(@Request() req: any) {
    // req.user được gán giá trị từ JwtStrategy.validate() của ông
    const userId = req.user._id;
    return this.authService.logout(userId);
  }

  // API lấy thông tin cá nhân (Cần gửi Token lên Header)
  @ApiBearerAuth() // Đánh dấu API này yêu cầu Token (Bearer)
  @ApiOperation({ summary: 'Lấy thông tin cá nhân hiện tại' })
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getProfile(@Request() req) {
    return req.user; // Dữ liệu này từ hàm validate() trong JwtStrategy
  }
}
