import {
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
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_REPORT_PUBLIC_ID_PATTERN } from '../constants/admin-report-assignment.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminReportPublicIdParamDto } from '../dto/admin-report-public-id.dto';
import { UpdateAdminReportDecisionDto } from '../dto/update-admin-report-decision.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import type { AdminReportDecisionActor } from '../interfaces/admin-report-decision.interface';
import { AdminReportDecisionService } from '../services/admin-report-decision.service';
import type { AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Reports')
@ApiBearerAuth('access-token')
@Controller('admin/reports')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.REPORTS_RESOLVE)
export class AdminReportDecisionController {
  constructor(private readonly decisions: AdminReportDecisionService) {}

  @Patch(':publicId/decision')
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_REPORT_PUBLIC_ID_PATTERN.source },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      pattern: ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOperation({ summary: 'Giải quyết hoặc từ chối report nguyên tử' })
  update(
    @Param() params: AdminReportPublicIdParamDto,
    @Body() dto: UpdateAdminReportDecisionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.decisions.update({
      actor: this.actor(request),
      reportPublicId: params.publicId,
      decision: dto.decision,
      targetAction: dto.targetAction,
      expectedReportVersion: dto.expectedReportVersion,
      expectedTargetVersion: dto.expectedTargetVersion,
      reasonCode: dto.reasonCode,
      actionReasonCode: dto.actionReasonCode,
      publicReasonCode: dto.publicReasonCode,
      expiresAt: dto.expiresAt,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(request: AdminAuthenticatedRequest): AdminReportDecisionActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission: AdminPermission.REPORTS_RESOLVE,
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
