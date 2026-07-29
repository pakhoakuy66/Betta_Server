import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import {
  ApiStandardErrors,
  ApiStandardSuccess,
} from '../../../common/decorators/api-standard-response.decorator';
import {
  createSuccessResponse,
  type ApiSuccessResponse,
} from '../../../common/interfaces/api-response.interface';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import {
  GOOGLE_OAUTH_CONTROLLER_ROUTE,
  GOOGLE_OAUTH_UNLINK_ROUTE,
} from '../constants/google-oauth-route.constants';
import { UnlinkGoogleOAuthAccountDto } from '../dto/unlink-google-oauth-account.dto';
import { AuthRateLimitService } from '../services/auth-rate-limit.service';
import { GoogleOAuthAccountUnlinkService } from '../services/google-oauth-account-unlink.service';

type AuthenticatedExpressRequest = Request & AuthenticatedRequest;

const SUCCESS_MESSAGE = 'Đã hủy liên kết tài khoản Google';

@ApiTags('Authentication')
@ApiBearerAuth('access-token')
@ApiStandardErrors()
@UseGuards(AuthGuard('jwt'))
@Controller(GOOGLE_OAUTH_CONTROLLER_ROUTE)
export class GoogleOAuthAccountController {
  constructor(
    private readonly rateLimitService: AuthRateLimitService,
    private readonly unlinkService: GoogleOAuthAccountUnlinkService,
  ) {}

  @Post(GOOGLE_OAUTH_UNLINK_ROUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hủy liên kết Google khỏi tài khoản hiện tại',
  })
  @ApiStandardSuccess()
  @ApiConflictResponse({
    description:
      'Google là phương thức đăng nhập cuối hoặc trạng thái liên kết đã thay đổi',
  })
  @ApiServiceUnavailableResponse({
    description: 'Không thể hoàn tất transaction bảo mật',
  })
  async unlinkAccount(
    @Req() request: AuthenticatedExpressRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: UnlinkGoogleOAuthAccountDto,
  ): Promise<ApiSuccessResponse<null>> {
    this.applyPrivateHeaders(response);

    const authenticatedUserId = this.parseAuthenticatedUserId(request.user._id);

    await this.rateLimitService.consumeGoogleOAuthUnlink(
      this.getClientIp(request),
      authenticatedUserId.toString(),
    );

    await this.unlinkService.unlinkGoogleAccount(
      authenticatedUserId,
      dto.currentPassword,
    );

    return createSuccessResponse<null>(null, SUCCESS_MESSAGE);
  }

  private parseAuthenticatedUserId(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    return new Types.ObjectId(value);
  }

  private getClientIp(request: Request): string {
    const clientIp = request.ip ?? request.socket.remoteAddress;

    if (typeof clientIp !== 'string' || clientIp.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Không thể xác định địa chỉ client',
      );
    }

    return clientIp.trim();
  }

  private applyPrivateHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }
}
