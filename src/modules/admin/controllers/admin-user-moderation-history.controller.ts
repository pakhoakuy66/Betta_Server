import {
  Controller,
  Get,
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
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminUserPublicIdParamDto } from '../dto/admin-user-public-id.dto';
import { ListAdminUserModerationHistoryQueryDto } from '../dto/list-admin-user-moderation-history.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminUserAccessLogger } from '../services/admin-user-access-logger.service';
import { AdminUserModerationHistoryService } from '../services/admin-user-moderation-history.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(
  AdminPermission.USERS_VIEW,
  AdminPermission.MODERATION_HISTORY_VIEW,
)
export class AdminUserModerationHistoryController {
  constructor(
    private readonly history: AdminUserModerationHistoryService,
    private readonly accessLogger: AdminUserAccessLogger,
  ) {}

  @Get(':publicId/moderation-history')
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_USER_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Lịch sử moderation append-only của User' })
  async list(
    @Param() params: AdminUserPublicIdParamDto,
    @Query() query: ListAdminUserModerationHistoryQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const result = await this.history.list({
      targetPublicId: params.publicId,
      page: query.page,
      limit: query.limit,
    });
    this.accessLogger.logModerationHistory({
      actorPublicId: request.user.publicId,
      targetPublicId: params.publicId,
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
