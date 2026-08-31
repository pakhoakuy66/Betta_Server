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
import { UpdateAdminReportAssignmentDto } from '../dto/update-admin-report-assignment.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import type { AdminReportAssignmentActor } from '../interfaces/admin-report-assignment.interface';
import { AdminReportAssignmentService } from '../services/admin-report-assignment.service';
import type { AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Reports')
@ApiBearerAuth('access-token')
@Controller('admin/reports')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.REPORTS_REVIEW)
export class AdminReportAssignmentController {
  constructor(private readonly assignments: AdminReportAssignmentService) {}

  @Patch(':publicId/assignment')
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
  @ApiOperation({ summary: 'Nhận xử lý hoặc chuyển người xử lý report' })
  update(
    @Param() params: AdminReportPublicIdParamDto,
    @Body() dto: UpdateAdminReportAssignmentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.assignments.update({
      actor: this.actor(request),
      reportPublicId: params.publicId,
      operation: dto.operation,
      expectedVersion: dto.expectedVersion,
      assigneePublicId: dto.assigneePublicId,
      adminNote: dto.adminNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
  ): AdminReportAssignmentActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission: AdminPermission.REPORTS_REVIEW,
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
