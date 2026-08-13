import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import { ADMIN_ACTIVATION_ROUTE } from '../constants/admin-activation.constants';
import {
  BeginAdminActivationDto,
  CompleteAdminActivationDto,
} from '../dto/admin-activation.dto';
import { AdminAuthOriginGuard } from '../guards/admin-auth-origin.guard';
import { type AdminActivationChallenge } from '../interfaces/admin-activation.interface';
import { AdminActivationService } from '../services/admin-activation.service';
import { AdminAuthCookieService } from '../services/admin-auth-cookie.service';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';

type AdminActivationTransportResponse = Readonly<{
  accessToken: string;
  csrfToken: string;
  accessTokenExpiresInSeconds: number;
  refreshCredentialExpiresAt: string;
  sessionId: string;
  admin: Readonly<{
    id: string;
    publicId: string;
    username: string;
    displayName: string;
    role: string;
  }>;
  recoveryCodes: readonly string[];
}>;

@ApiTags('Admin Activation')
@Controller(ADMIN_ACTIVATION_ROUTE)
@UseGuards(AdminAuthOriginGuard)
export class AdminActivationController {
  constructor(
    private readonly activation: AdminActivationService,
    private readonly cookies: AdminAuthCookieService,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
  ) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Khoi tao challenge kich hoat Admin' })
  async start(
    @Body() dto: BeginAdminActivationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminActivationChallenge> {
    this.setNoStore(response);
    const challenge = await this.activation.begin({
      adminPublicId: dto.adminPublicId,
      activationGrant: dto.activationGrant,
      trustedClientIp: getAdminTrustedClientIp(request),
    });
    return challenge;
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hoan tat password, MFA va kich hoat Admin' })
  async complete(
    @Body() dto: CompleteAdminActivationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminActivationTransportResponse> {
    this.setNoStore(response);
    const result = await this.activation.complete({
      adminPublicId: dto.adminPublicId,
      activationGrant: dto.activationGrant,
      newPassword: dto.newPassword,
      confirmPassword: dto.confirmPassword,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
      userAgent: request.get('user-agent'),
    });
    const csrfToken = this.cookies.writeSession(
      response,
      result.authentication,
    );
    return Object.freeze({
      accessToken: result.authentication.accessToken,
      csrfToken,
      accessTokenExpiresInSeconds: this.policy.session.accessTokenTtlSeconds,
      refreshCredentialExpiresAt:
        result.authentication.refreshTokenExpiresAt.toISOString(),
      sessionId: result.authentication.sessionPublicId,
      admin: result.authentication.admin,
      recoveryCodes: result.recoveryCodes,
    });
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
