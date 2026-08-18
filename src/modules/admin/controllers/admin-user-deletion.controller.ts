import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Types } from 'mongoose';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN } from '../constants/admin-lifecycle.constants';
import { getAdminUserDeletionPermission } from '../constants/admin-user-deletion.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { AdminUserPublicIdParamDto } from '../dto/admin-user-public-id.dto';
import { UpdateAdminUserDeletionDto } from '../dto/update-admin-user-deletion.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminUserDeletionPermissionGuard } from '../guards/admin-user-deletion-permission.guard';
import type { AdminUserDeletionActor } from '../interfaces/admin-user-deletion.interface';
import { AdminUserDeletionService } from '../services/admin-user-deletion.service';
import type { AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUserDeletionController {
  constructor(private readonly deletions: AdminUserDeletionService) {}

  @Patch(':publicId/deletion')
  @UseGuards(AdminUserDeletionPermissionGuard)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_USER_PUBLIC_ID_PATTERN.source },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      pattern: ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOperation({ summary: 'Xóa mềm hoặc khôi phục User do Admin quản lý' })
  update(
    @Param() params: AdminUserPublicIdParamDto,
    @Body() dto: UpdateAdminUserDeletionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminUserDeletionPermission(dto.operation);
    if (!permission) {
      throw new BadRequestException('Deletion operation không hợp lệ');
    }
    return this.deletions.updateDeletion({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      operation: dto.operation,
      expectedVersion: dto.expectedVersion,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
    permission: AdminUserDeletionActor['permission'],
  ): AdminUserDeletionActor {
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
