import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminPostModerationAccessLogger } from '../services/admin-post-moderation-access-logger.service';
import { AdminPostModerationDetailService } from '../services/admin-post-moderation-detail.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Reports')
@ApiBearerAuth('access-token')
@Controller('admin/reports')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class AdminPostModerationDetailController {
  constructor(
    private readonly detail: AdminPostModerationDetailService,
    private readonly accessLogger: AdminPostModerationAccessLogger,
  ) {}

  @Get(':publicId/post-detail')
  @RequireAdminPermissions(
    AdminPermission.REPORTS_VIEW,
    AdminPermission.POSTS_VIEW,
  )
  @ApiOperation({
    summary: 'Chi tiết moderation Post từ immutable report snapshot',
  })
  async getPostDetail(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const result = await this.detail.getByReportPublicId(publicId);
    this.accessLogger.logDetail({
      actorPublicId: request.user.publicId,
      reportPublicId: result.reportPublicId,
      targetState: result.target.state,
      mediaCount: result.evidence.media.length,
      redactedMediaCount: result.evidence.media.filter(
        ({ redacted }) => redacted,
      ).length,
    });
    return result;
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
