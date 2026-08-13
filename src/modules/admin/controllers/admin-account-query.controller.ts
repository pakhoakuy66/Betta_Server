import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { type Response } from 'express';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminAccountPublicIdParamDto } from '../dto/admin-account-public-id.dto';
import { ListAdminAccountsQueryDto } from '../dto/list-admin-accounts.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminAccountQueryService } from '../services/admin-account-query.service';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

@ApiTags('SuperAdmin Accounts')
@ApiBearerAuth()
@Controller('super-admin/admins')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.ADMINS_VIEW)
export class AdminAccountQueryController {
  constructor(private readonly accounts: AdminAccountQueryService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách AdminAccount theo public contract' })
  list(
    @Query() query: ListAdminAccountsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.accounts.list({
      page: query.page,
      limit: query.limit,
      role: query.role,
      status: query.status,
      mfaStatus: query.mfaStatus,
      search: query.search,
    });
  }

  @Get(':publicId')
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: ADMIN_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Chi tiết AdminAccount theo public ID' })
  detail(
    @Param() params: AdminAccountPublicIdParamDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.setNoStore(response);
    return this.accounts.detail(params.publicId);
  }

  private setNoStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
