import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { type Response } from 'express';
import { Types } from 'mongoose';
import { getAdminAccountStatusPermission } from '../constants/admin-account-status.constants';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminAccountPublicIdParamDto } from '../dto/admin-account-public-id.dto';
import {
  IssueSuperAdminStatusReauthDto,
  UpdateAdminAccountStatusDto,
} from '../dto/update-admin-account-status.dto';
import { AdminAccountStatusPermissionGuard } from '../guards/admin-account-status-permission.guard';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { type AdminAccountStatusActor } from '../interfaces/admin-account-status.interface';
import { AdminAccountStatusService } from '../services/admin-account-status.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

@ApiTags('SuperAdmin Accounts')
@ApiBearerAuth()
@Controller('super-admin/admins')
@UseGuards(AdminJwtAuthGuard)
export class AdminAccountStatusController {
  constructor(private readonly statuses: AdminAccountStatusService) {}

  @Post(':publicId/status-reauth')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminAccountStatusPermissionGuard)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Xác thực lại trước khi đổi trạng thái SuperAdmin' })
  issueSuperAdminStatusReauth(
    @Param() params: AdminAccountPublicIdParamDto,
    @Body() dto: IssueSuperAdminStatusReauthDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminAccountStatusPermission(dto.status);
    if (!permission) throw new TypeError('AdminAccount status không hợp lệ');

    return this.statuses.issueSuperAdminStatusReauth({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      status: dto.status,
      password: dto.password,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
    });
  }

  @Patch(':publicId/status')
  @UseGuards(AdminAccountStatusPermissionGuard)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Khóa hoặc mở khóa một AdminAccount bằng CAS' })
  updateStatus(
    @Param() params: AdminAccountPublicIdParamDto,
    @Body() dto: UpdateAdminAccountStatusDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminAccountStatusPermission(dto.status);
    if (!permission) throw new TypeError('AdminAccount status không hợp lệ');

    return this.statuses.updateStatus({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      status: dto.status,
      expectedVersion: dto.expectedVersion,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      reauthGrant: dto.reauthGrant,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
    permission: AdminPermission,
  ): AdminAccountStatusActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission,
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
