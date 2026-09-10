import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermissions } from '../admin/decorators/require-admin-permissions.decorator';
import { AdminPermission as Permission } from '../admin/constants/admin-permission.constants';
import type { AdminAuthenticatedRequest } from '../admin/types/admin-authenticated-request';
import { SponsoredPostQueryParams } from './sponsored-post-query.dto';
import { SponsoredVersionMutationDto } from './sponsored-post-mutation.dto';
import { SponsoredTransition as Action } from './sponsored-post.constants';
import { SponsoredLifecycleService } from './sponsored-lifecycle.service';

@Controller('admin/sponsored-posts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class SponsoredLifecycleController {
  constructor(private readonly lifecycle: SponsoredLifecycleService) {}
  @Post(':publicId/schedule')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_SCHEDULE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async schedule(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.lifecycle.execute(
        request.user,
        params.publicId,
        Action.SCHEDULE,
        body,
      ),
    };
  }
  @Post(':publicId/activate')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_SCHEDULE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async activate(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.lifecycle.execute(
        request.user,
        params.publicId,
        Action.ACTIVATE,
        body,
      ),
    };
  }
  @Post(':publicId/pause')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_PAUSE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async pause(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.lifecycle.execute(
        request.user,
        params.publicId,
        Action.PAUSE,
        body,
      ),
    };
  }
  @Post(':publicId/resume')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_PAUSE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async resume(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.lifecycle.execute(
        request.user,
        params.publicId,
        Action.RESUME,
        body,
      ),
    };
  }
  @Post(':publicId/return-to-draft')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_SCHEDULE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async returnToDraft(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.lifecycle.execute(
        request.user,
        params.publicId,
        Action.RETURN_TO_DRAFT,
        body,
      ),
    };
  }
}
