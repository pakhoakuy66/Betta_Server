import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Headers,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Types } from 'mongoose';
import { type Response } from 'express';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import {
  CreateAdminAccountDto,
  IssueAdminCreateReauthDto,
} from '../dto/create-admin-account.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { type AdminLifecycleActor } from '../interfaces/admin-account-lifecycle.interface';
import { AdminAccountLifecycleService } from '../services/admin-account-lifecycle.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';

@ApiTags('SuperAdmin Accounts')
@ApiBearerAuth('access-token')
@Controller('super-admin/admins')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.ADMINS_CREATE)
export class AdminAccountLifecycleController {
  constructor(private readonly lifecycle: AdminAccountLifecycleService) {}

  @Post('create-reauth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xác thực lại trước khi tạo Admin' })
  issueCreateReauth(
    @Body() dto: IssueAdminCreateReauthDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.lifecycle.issueCreateReauth({
      actor: this.actor(request),
      password: dto.password,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
    });
  }

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Khóa duy nhất 16-128 ký tự cho một yêu cầu tạo Admin',
  })
  @ApiOperation({ summary: 'Tạo tài khoản Admin chờ activation' })
  create(
    @Body() dto: CreateAdminAccountDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.lifecycle.createAdmin({
      actor: this.actor(request),
      email: dto.email,
      username: dto.username,
      displayName: dto.displayName,
      reauthGrant: dto.reauthGrant,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(request: AdminAuthenticatedRequest): AdminLifecycleActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission: AdminPermission.ADMINS_CREATE,
      permissionVersion: request.user.permissionVersion,
      sessionPublicId: request.user.sessionId,
      credentialVersion: request.user.credentialVersion,
      authzVersion: request.user.authzVersion,
    });
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
