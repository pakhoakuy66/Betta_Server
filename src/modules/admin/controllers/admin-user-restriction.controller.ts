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
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { getAdminUserRestrictionPermission } from '../constants/admin-user-restriction.constants';
import { AdminUserPublicIdParamDto } from '../dto/admin-user-public-id.dto';
import { UpdateAdminUserRestrictionDto } from '../dto/update-admin-user-restriction.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminUserRestrictionPermissionGuard } from '../guards/admin-user-restriction-permission.guard';
import type { AdminUserRestrictionActor } from '../interfaces/admin-user-restriction.interface';
import { AdminUserRestrictionService } from '../services/admin-user-restriction.service';
import type { AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUserRestrictionController {
  constructor(private readonly restrictions: AdminUserRestrictionService) {}

  @Patch(':publicId/status')
  @UseGuards(AdminUserRestrictionPermissionGuard)
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
  @ApiOperation({ summary: 'Áp dụng hoặc gỡ typed restriction của User' })
  update(
    @Param() params: AdminUserPublicIdParamDto,
    @Body() dto: UpdateAdminUserRestrictionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const permission = getAdminUserRestrictionPermission(
      dto.operation,
      dto.restrictionType,
    );
    if (!permission) {
      throw new BadRequestException('Restriction operation không hợp lệ');
    }

    return this.restrictions.updateRestriction({
      actor: this.actor(request, permission),
      targetPublicId: params.publicId,
      operation: dto.operation,
      restrictionType: dto.restrictionType,
      expectedVersion: dto.expectedVersion,
      expiresAt: dto.expiresAt,
      publicReasonCode: dto.publicReasonCode,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
    permission: AdminUserRestrictionActor['permission'],
  ): AdminUserRestrictionActor {
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
