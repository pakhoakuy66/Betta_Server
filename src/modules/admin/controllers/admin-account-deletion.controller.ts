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
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { getAdminAccountDeletionPermission } from '../constants/admin-account-deletion.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminAccountPublicIdParamDto } from '../dto/admin-account-public-id.dto';
import {
  IssueSuperAdminDeletionReauthDto,
  UpdateAdminAccountDeletionDto,
} from '../dto/update-admin-account-deletion.dto';
import { AdminAccountDeletionPermissionGuard } from '../guards/admin-account-deletion-permission.guard';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { type AdminAccountDeletionActor } from '../interfaces/admin-account-deletion.interface';
import { AdminAccountDeletionService } from '../services/admin-account-deletion.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

@ApiTags('SuperAdmin Accounts')
@ApiBearerAuth()
@Controller('super-admin/admins')
@UseGuards(AdminJwtAuthGuard)
export class AdminAccountDeletionController {
  constructor(private readonly deletions: AdminAccountDeletionService) {}

  @Post(':publicId/deletion-reauth')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminAccountDeletionPermissionGuard)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Xác thực lại cho lifecycle xóa SuperAdmin' })
  issueReauth(
    @Param() params: AdminAccountPublicIdParamDto,
    @Body() dto: IssueSuperAdminDeletionReauthDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminAccountDeletionPermission(dto.action);
    if (!permission) throw new TypeError('Admin deletion action không hợp lệ');
    return this.deletions.issueSuperAdminDeletionReauth({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      action: dto.action,
      password: dto.password,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
    });
  }

  @Patch(':publicId/deletion')
  @UseGuards(AdminAccountDeletionPermissionGuard)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Xóa mềm hoặc khôi phục AdminAccount bằng CAS' })
  updateDeletion(
    @Param() params: AdminAccountPublicIdParamDto,
    @Body() dto: UpdateAdminAccountDeletionDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminAccountDeletionPermission(dto.action);
    if (!permission) throw new TypeError('Admin deletion action không hợp lệ');
    return this.deletions.updateDeletion({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      action: dto.action,
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
  ): AdminAccountDeletionActor {
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
