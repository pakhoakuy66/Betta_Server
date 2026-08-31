import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
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
import { ADMIN_REPORT_PUBLIC_ID_PATTERN } from '../constants/admin-report-assignment.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  ADMIN_MODERATION_HISTORY_ACCESSED_EVENT,
  AdminModerationHistoryResource,
} from '../constants/admin-moderation-history.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminPostPublicIdParamDto } from '../dto/admin-post-public-id.dto';
import { AdminReportPublicIdParamDto } from '../dto/admin-report-public-id.dto';
import { AdminUserPublicIdParamDto } from '../dto/admin-user-public-id.dto';
import { ListAdminModerationHistoryQueryDto } from '../dto/list-admin-moderation-history.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { type AdminModerationHistoryPage } from '../interfaces/admin-moderation-history.interface';
import { AdminModerationHistoryService } from '../services/admin-moderation-history.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { POST_PUBLIC_ID_PATTERN } from '../../posts/utils/generate-post-public-id';

@ApiTags('Admin Moderation History')
@ApiBearerAuth('access-token')
@Controller('admin')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class AdminModerationHistoryController {
  private readonly logger = new Logger('AdminModerationHistorySecurityAccess');

  constructor(private readonly history: AdminModerationHistoryService) {}

  @Get('users/:publicId/moderation-history')
  @RequireAdminPermissions(
    AdminPermission.USERS_VIEW,
    AdminPermission.MODERATION_HISTORY_VIEW,
  )
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_USER_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Safe append-only moderation history của User' })
  async listUser(
    @Param() params: AdminUserPublicIdParamDto,
    @Query() query: ListAdminModerationHistoryQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminModerationHistoryPage> {
    return this.list(
      AdminModerationHistoryResource.USER,
      params.publicId,
      query,
      request,
      response,
    );
  }

  @Get('posts/:publicId/moderation-history')
  @RequireAdminPermissions(
    AdminPermission.POSTS_VIEW,
    AdminPermission.MODERATION_HISTORY_VIEW,
  )
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: POST_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Safe append-only moderation history của Post' })
  async listPost(
    @Param() params: AdminPostPublicIdParamDto,
    @Query() query: ListAdminModerationHistoryQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminModerationHistoryPage> {
    return this.list(
      AdminModerationHistoryResource.POST,
      params.publicId,
      query,
      request,
      response,
    );
  }

  @Get('reports/:publicId/moderation-history')
  @RequireAdminPermissions(
    AdminPermission.REPORTS_VIEW,
    AdminPermission.MODERATION_HISTORY_VIEW,
  )
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_REPORT_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Safe append-only moderation history của Report' })
  async listReport(
    @Param() params: AdminReportPublicIdParamDto,
    @Query() query: ListAdminModerationHistoryQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminModerationHistoryPage> {
    return this.list(
      AdminModerationHistoryResource.REPORT,
      params.publicId,
      query,
      request,
      response,
    );
  }

  private async list(
    resource: AdminModerationHistoryResource,
    targetPublicId: string,
    query: ListAdminModerationHistoryQueryDto,
    request: AdminAuthenticatedRequest,
    response: Response,
  ): Promise<AdminModerationHistoryPage> {
    this.setPrivateHeaders(response);
    const result = await this.history.list({
      resource,
      targetPublicId,
      page: query.page,
      limit: query.limit,
    });
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_MODERATION_HISTORY_ACCESSED_EVENT,
        operation: 'VIEW_MODERATION_HISTORY',
        actorPublicId: request.user.publicId,
        targetType: result.target.type,
        targetPublicId,
        resultCount: result.items.length,
      }),
    );
    return result;
  }

  private setPrivateHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }
}
