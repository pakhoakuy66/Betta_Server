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
import { ListAdminUsersQueryDto } from '../dto/list-admin-users.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminUserAccessLogger } from '../services/admin-user-access-logger.service';
import { AdminUserQueryService } from '../services/admin-user-query.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';

@ApiTags('Admin Users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.USERS_VIEW)
export class AdminUserQueryController {
  constructor(
    private readonly users: AdminUserQueryService,
    private readonly accessLogger: AdminUserAccessLogger,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách User theo contract quản trị tối thiểu' })
  async list(
    @Query() query: ListAdminUsersQueryDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const result = await this.users.list({
      page: query.page,
      limit: query.limit,
      status: query.status,
      deletion: query.deletion,
      restriction: query.restriction,
      loginLock: query.loginLock,
      sort: query.sort,
      search: query.search,
    });
    this.accessLogger.logList({
      actorPublicId: request.user.publicId,
      resultCount: result.items.length,
    });
    return result;
  }

  @Get(':publicId')
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_USER_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Chi tiết User theo public ID' })
  async detail(
    @Param() params: AdminUserPublicIdParamDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    const result = await this.users.detail(params.publicId);
    this.accessLogger.logDetail({
      actorPublicId: request.user.publicId,
      targetPublicId: params.publicId,
    });
    return result;
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
