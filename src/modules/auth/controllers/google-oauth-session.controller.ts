import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  createSuccessResponse,
  type ApiSuccessResponse,
} from '../../../common/interfaces/api-response.interface';
import {
  GOOGLE_OAUTH_CONTROLLER_ROUTE,
  GOOGLE_OAUTH_SESSION_ROUTE,
} from '../constants/google-oauth-route.constants';
import { GoogleOAuthContinuationOriginGuard } from '../guards/google-oauth-continuation-origin.guard';
import type { AuthResponse } from '../interfaces/auth.interface';
import { AuthRateLimitService } from '../services/auth-rate-limit.service';
import { GoogleOAuthSessionHandoffCookieService } from '../services/google-oauth-session-handoff-cookie.service';
import { GoogleOAuthSessionHandoffService } from '../services/google-oauth-session-handoff.service';

type RedeemedGoogleOAuthSession = Omit<AuthResponse, 'message'>;

@ApiTags('Authentication')
@Controller(GOOGLE_OAUTH_CONTROLLER_ROUTE)
@UseGuards(GoogleOAuthContinuationOriginGuard)
export class GoogleOAuthSessionController {
  constructor(
    private readonly rateLimitService: AuthRateLimitService,
    private readonly cookieService: GoogleOAuthSessionHandoffCookieService,
    private readonly handoffService: GoogleOAuthSessionHandoffService,
  ) {}

  @Post(GOOGLE_OAUTH_SESSION_ROUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Doi session handoff lay phien dang nhap',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Tra AuthResponse chuan mot lan',
  })
  async redeemSession(
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ): Promise<ApiSuccessResponse<RedeemedGoogleOAuthSession>> {
    this.applyPrivateHeaders(response);

    try {
      await this.rateLimitService.consumeGoogleOAuthSession(
        this.getClientIp(request),
      );

      const rawHandoff = this.cookieService.read(request);

      const { message, ...session } =
        await this.handoffService.consume(rawHandoff);

      this.cookieService.clear(response);

      return createSuccessResponse(session, message);
    } catch (error: unknown) {
      if (this.cookieService.shouldClearAfterError(error)) {
        this.cookieService.clear(response);
      }

      throw error;
    }
  }

  private getClientIp(request: Request): string {
    const clientIp = request.ip ?? request.socket.remoteAddress;

    if (typeof clientIp !== 'string' || clientIp.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Khong the xac dinh dia chi client',
      );
    }

    return clientIp.trim();
  }

  private applyPrivateHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }
}
