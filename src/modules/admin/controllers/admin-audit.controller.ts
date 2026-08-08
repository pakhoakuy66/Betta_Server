import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ADMIN_AUDIT_TIMELINE_TARGET_PUBLIC_ID,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { ListAdminAuditQueryDto } from '../dto/list-admin-audit.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { type AdminAuditPage } from '../interfaces/admin-audit.interface';
import { AdminAuditService } from '../services/admin-audit.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('SuperAdmin Audit')
@ApiBearerAuth()
@Controller('super-admin/audit-logs')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.AUDIT_LOGS_VIEW)
export class AdminAuditController {
  constructor(private readonly auditService: AdminAuditService) {}

  @Get()
  @ApiOperation({ summary: 'Tra cứu audit log quản trị append-only' })
  async list(
    @Query() query: ListAdminAuditQueryDto,
    @Req() request: AdminAuthenticatedRequest,
  ): Promise<AdminAuditPage> {
    const page = await this.auditService.list({
      page: query.page,
      limit: query.limit,
      actorPublicId: query.actorPublicId,
      action: query.action,
      targetType: query.targetType,
      targetPublicId: query.targetPublicId,
      outcome: query.outcome,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });

    await this.auditService.record({
      action: AdminAuditAction.AUDIT_LOG_ACCESSED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        publicId: request.user.publicId,
        username: request.user.username,
        displayName: request.user.displayName,
        role: request.user.role,
        permission: AdminPermission.AUDIT_LOGS_VIEW,
        permissionVersion: request.user.permissionVersion,
      },
      target: {
        type: AdminAuditTargetType.AUDIT_LOG,
        publicId: ADMIN_AUDIT_TIMELINE_TARGET_PUBLIC_ID,
      },
      reasonCode: 'audit_timeline_viewed',
      source: AdminAuditSource.HTTP,
    });

    return page;
  }
}
