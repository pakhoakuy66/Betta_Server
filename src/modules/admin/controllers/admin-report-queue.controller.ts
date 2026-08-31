import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { ListAdminReportQueueDto } from '../dto/list-admin-report-queue.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminReportAccessLogger } from '../services/admin-report-access-logger.service';
import { AdminReportQueueService } from '../services/admin-report-queue.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Reports')
@ApiBearerAuth('access-token')
@Controller('admin/reports')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.REPORTS_VIEW)
export class AdminReportQueueController {
  constructor(
    private readonly queue: AdminReportQueueService,
    private readonly accessLogger: AdminReportAccessLogger,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Hàng đợi report hợp nhất với SLA và projection an toàn',
  })
  async list(
    @Query() query: ListAdminReportQueueDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const result = await this.queue.list({
      page: query.page,
      limit: query.limit,
      type: query.type,
      status: query.status,
      reason: query.reason,
      priority: query.priority,
      assignee: query.assignee,
      sla: query.sla,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      sort: query.sort,
    });
    this.accessLogger.logList({
      actorPublicId: request.user.publicId,
      resultCount: result.items.length,
    });
    return result;
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
