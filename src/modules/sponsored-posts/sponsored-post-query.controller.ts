import {
  Controller,
  Get,
  Header,
  Logger,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermissions } from '../admin/decorators/require-admin-permissions.decorator';
import { AdminPermission } from '../admin/constants/admin-permission.constants';
import { type AdminAuthenticatedRequest } from '../admin/types/admin-authenticated-request';
import {
  SponsoredPostQueryDto,
  SponsoredPostQueryParams,
} from './sponsored-post-query.dto';
import { SponsoredPostQueryService } from './sponsored-post-query.service';

@Controller('admin/sponsored-posts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(AdminPermission.SPONSORED_POSTS_VIEW)
export class SponsoredPostQueryController {
  private readonly logger = new Logger('SponsoredPostSecurityAccess');
  constructor(private readonly reader: SponsoredPostQueryService) {}

  @Get()
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async list(
    @Query() query: SponsoredPostQueryDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const data = await this.reader.list(query);
    this.logger.log(
      JSON.stringify({
        eventCode: 'SPONSORED_LIST_ACCESSED',
        actorPublicId: request.user.publicId,
        resultCount: data.items.length,
      }),
    );
    return { success: true, data };
  }

  @Get(':publicId')
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  async detail(
    @Param() params: SponsoredPostQueryParams,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const data = await this.reader.detail(params.publicId);
    this.logger.log(
      JSON.stringify({
        eventCode: 'SPONSORED_DETAIL_ACCESSED',
        actorPublicId: request.user.publicId,
        targetPublicId: params.publicId,
      }),
    );
    return { success: true, data };
  }
}
