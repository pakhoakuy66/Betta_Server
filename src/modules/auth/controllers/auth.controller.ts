import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  UseGuards,
  Request,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { AuthService } from '../services/auth.service';
import { AuthRateLimitService } from '../services/auth-rate-limit.service';
import { createSuccessResponse } from '../../../common/interfaces/api-response.interface';
import {
  ApiStandardErrors,
  ApiStandardSuccess,
} from '../../../common/decorators/api-standard-response.decorator';
import {
  RegisterDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  RefreshTokenDto,
  ChangePasswordDto,
} from '../dto/auth.dto';
import { LoginDto } from '../dto/auth.dto';

@ApiTags('Authentication') // Gom nhóm các API này vào mục Authentication trên Swagger
@Controller('auth') // API sẽ gọi vào: http://localhost:5000/api/v1/auth
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  private getClientIp(request: ExpressRequest): string {
    const ip = request.ip ?? request.socket.remoteAddress;

    if (!ip) {
      throw new ServiceUnavailableException('Không thể xác định nguồn yêu cầu');
    }

    return ip;
  }

  @ApiOperation({ summary: 'Đăng ký tài khoản mới' })
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @ApiOperation({ summary: 'Đăng nhập hệ thống' })
  @ApiStandardSuccess()
  @ApiStandardErrors()
  @Post('login')
  async login(@Req() request: ExpressRequest, @Body() loginDto: LoginDto) {
    await this.rateLimit.consume(
      'login',
      this.getClientIp(request),
      loginDto.email,
    );

    const { message, ...session } = await this.authService.login(loginDto, {
      userAgent: request.get('user-agent'),
    });

    return createSuccessResponse(session, message);
  }

  @ApiOperation({ summary: 'Yêu cầu gửi mã OTP quên mật khẩu' })
  @Post('forgot-password')
  async forgotPassword(
    @Req() request: ExpressRequest,
    @Body() dto: ForgotPasswordDto,
  ) {
    await this.rateLimit.consume(
      'forgot',
      this.getClientIp(request),
      dto.email,
    );

    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({ summary: 'Xác thực mã OTP' })
  @Post('verify-otp')
  async verifyOtp(@Req() request: ExpressRequest, @Body() dto: VerifyOtpDto) {
    await this.rateLimit.consume('otp', this.getClientIp(request), dto.email);

    return this.authService.verifyOtp(dto);
  }

  @ApiOperation({ summary: 'Đặt lại mật khẩu mới bằng OTP' })
  @Post('reset-password')
  async resetPassword(
    @Req() request: ExpressRequest,
    @Body() dto: ResetPasswordDto,
  ) {
    await this.rateLimit.consume('otp', this.getClientIp(request), dto.email);

    return this.authService.resetPassword(dto);
  }

  @ApiOperation({ summary: 'Làm mới Access Token' })
  @ApiStandardSuccess()
  @ApiStandardErrors()
  @Post('refresh-token')
  async refreshToken(@Body() dto: RefreshTokenDto) {
    const tokens = await this.authService.refreshToken(dto.refreshToken);

    return createSuccessResponse(tokens);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Đổi mật khẩu khi người dùng đã đăng nhập' })
  @UseGuards(AuthGuard('jwt'))
  @Patch('change-password')
  async changePassword(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(req.user._id, dto);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Đăng xuất hệ thống' })
  @ApiStandardSuccess()
  @ApiStandardErrors()
  @UseGuards(AuthGuard('jwt'))
  @Post('logout')
  async logout(@Request() req: AuthenticatedRequest) {
    const result = await this.authService.logout(
      req.user._id,
      req.user.sessionId,
    );

    return createSuccessResponse(null, result.message);
  }

  // API lấy thông tin cá nhân (Cần gửi Token lên Header)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Lấy thông tin cá nhân hiện tại',
  })
  @ApiStandardSuccess()
  @ApiStandardErrors()
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  async getProfile(@Request() req: AuthenticatedRequest) {
    const user = await this.authService.getCurrentUser(req.user._id);

    return createSuccessResponse(user);
  }
}
