import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import { ADMIN_AUTH_ROUTE } from '../constants/admin-auth-transport.constants';
import { AdminLoginDto } from '../dto/admin-login.dto';
import {
  AdminSessionParamsDto,
  ListAdminSessionsQueryDto,
} from '../dto/admin-session.dto';
import { AdminAuthOriginGuard } from '../guards/admin-auth-origin.guard';
import { AdminCsrfGuard } from '../guards/admin-csrf.guard';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { type AdminAuthenticationResult } from '../interfaces/admin-auth.interface';
import {
  type AdminAuthTransportResponse,
  type AdminCsrfBootstrapResponse,
  type PublicAdminPrincipal,
} from '../interfaces/admin-auth-transport.interface';
import { type AdminSessionAccount } from '../interfaces/admin-session.interface';
import { AdminAuthCookieService } from '../services/admin-auth-cookie.service';
import { AdminAuthService } from '../services/admin-auth.service';
import { AdminSessionService } from '../services/admin-session.service';
import {
  type AdminAuthenticatedRequest,
  type AdminRequestPrincipal,
} from '../types/admin-authenticated-request';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';

@ApiTags('Admin Authentication')
@Controller(ADMIN_AUTH_ROUTE)
@UseGuards(AdminAuthOriginGuard)
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: AdminSessionService,
    private readonly cookies: AdminAuthCookieService,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dang nhap Admin bang password va TOTP' })
  async login(
    @Body() dto: AdminLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminAuthTransportResponse> {
    const result = await this.auth.login({
      email: dto.email,
      password: dto.password,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
      userAgent: request.get('user-agent'),
    });

    const csrfToken = this.cookies.writeSession(response, result);
    this.setNoStore(response);
    return this.toTransportResponse(result, csrfToken);
  }

  @Post('csrf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Khoi tao lai CSRF proof sau khi Admin UI reload' })
  bootstrapCsrf(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): AdminCsrfBootstrapResponse {
    const csrfToken = this.cookies.readCsrfBootstrapProof(request);
    this.setNoStore(response);
    return Object.freeze({ csrfToken });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminCsrfGuard)
  @ApiOperation({ summary: 'Rotate Admin refresh credential' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminAuthTransportResponse> {
    try {
      const refreshCredential = this.cookies.readRefreshCredential(request);
      const result = await this.auth.refresh(refreshCredential);

      const csrfToken = this.cookies.writeSession(response, result);
      this.setNoStore(response);
      return this.toTransportResponse(result, csrfToken);
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        this.cookies.clearSession(response);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminCsrfGuard, AdminJwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Dang xuat phien Admin hien tai' })
  async logout(
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Readonly<{ revoked: boolean }>> {
    const revoked = await this.auth.logout(
      this.toSessionAccount(request.user),
      request.user.sessionId,
    );

    this.cookies.clearSession(response);
    this.setNoStore(response);
    return Object.freeze({ revoked });
  }

  @Get('me')
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Lay principal Admin hien tai' })
  me(
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): PublicAdminPrincipal {
    this.setNoStore(response);
    return Object.freeze({
      id: request.user.publicId,
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      sessionId: request.user.sessionId,
    });
  }

  @Get('sessions')
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Liet ke cac phien Admin dang hoat dong' })
  async listSessions(
    @Query() query: ListAdminSessionsQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const page = await this.sessions.listActiveSessions(
      new Types.ObjectId(request.user.adminAccountId),
      request.user.sessionId,
      query.page,
      query.limit,
    );
    this.setNoStore(response);
    return page;
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Thu hoi mot phien Admin khac' })
  async revokeSession(
    @Param() params: AdminSessionParamsDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Readonly<{ revoked: true }>> {
    await this.sessions.revokeOtherSession(
      this.toSessionAccount(request.user),
      request.user.sessionId,
      params.sessionId,
    );
    this.setNoStore(response);
    return Object.freeze({ revoked: true as const });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Thu hoi tat ca phien cua Admin hien tai' })
  async logoutAll(
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Readonly<{ revokedCount: number }>> {
    const revokedCount = await this.sessions.logoutAllSelf(
      this.toSessionAccount(request.user),
    );
    this.cookies.clearSession(response);
    this.setNoStore(response);
    return Object.freeze({ revokedCount });
  }

  private toTransportResponse(
    result: AdminAuthenticationResult,
    csrfToken: string,
  ): AdminAuthTransportResponse {
    return Object.freeze({
      accessToken: result.accessToken,
      csrfToken,
      accessTokenExpiresInSeconds: this.policy.session.accessTokenTtlSeconds,
      refreshCredentialExpiresAt: result.refreshTokenExpiresAt.toISOString(),
      sessionId: result.sessionPublicId,
      admin: result.admin,
    });
  }

  private toSessionAccount(
    principal: AdminRequestPrincipal,
  ): AdminSessionAccount {
    return Object.freeze({
      _id: new Types.ObjectId(principal.adminAccountId),
      publicId: principal.publicId,
      username: principal.username,
      displayName: principal.displayName,
      role: principal.role,
      credentialVersion: principal.credentialVersion,
      authzVersion: principal.authzVersion,
      permissionVersion: principal.permissionVersion,
    });
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
