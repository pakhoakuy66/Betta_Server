import {
  Controller,
  Get,
  HttpStatus,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  GOOGLE_OAUTH_CONTROLLER_ROUTE,
  GOOGLE_OAUTH_START_ROUTE,
} from '../constants/google-oauth-route.constants';
import { AuthRateLimitService } from '../services/auth-rate-limit.service';
import { GoogleOAuthStateCookieService } from '../services/google-oauth-state-cookie.service';
import { GoogleOAuthTransactionService } from '../services/google-oauth-transaction.service';

@ApiTags('Authentication')
@Controller(GOOGLE_OAUTH_CONTROLLER_ROUTE)
export class GoogleOAuthAuthorizationController {
  constructor(
    private readonly rateLimitService: AuthRateLimitService,
    private readonly transactionService: GoogleOAuthTransactionService,
    private readonly stateCookieService: GoogleOAuthStateCookieService,
  ) {}

  @Get(GOOGLE_OAUTH_START_ROUTE)
  @ApiOperation({
    summary: 'Bắt đầu đăng nhập bằng Google',
  })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'Chuyển hướng trình duyệt sang Google',
  })
  async startAuthorization(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.applyPrivateHeaders(response);

    const clientIp = this.getClientIp(request);

    await this.rateLimitService.consumeGoogleOAuthStart(clientIp);

    const authorization = await this.transactionService.beginAuthorization();

    this.stateCookieService.write(
      response,
      authorization.browserState,
      authorization.expiresAt,
    );

    // Không dùng response.redirect(): Express có thể đưa URL
    // chứa OAuth state vào HTML response body.
    response.statusCode = HttpStatus.FOUND;

    response.setHeader('Location', authorization.authorizationUrl);

    response.end();
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
