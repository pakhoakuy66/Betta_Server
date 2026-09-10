import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
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
import {
  CreateSponsoredPostDto,
  UpdateSponsoredPostDto,
  SponsoredVersionMutationDto,
} from './sponsored-post-mutation.dto';
import { SponsoredPostMutationService } from './sponsored-post-mutation.service';

@Controller('admin/sponsored-posts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class SponsoredPostMutationController {
  constructor(private readonly mutations: SponsoredPostMutationService) {}
  @Post()
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_CREATE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async create(
    @Body() body: CreateSponsoredPostDto,
    @Headers('idempotency-key') key: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.mutations.execute(
        request.user,
        'create',
        null,
        body,
        key,
      ),
    };
  }
  @Patch(':publicId')
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_UPDATE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async update(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: UpdateSponsoredPostDto,
    @Headers('idempotency-key') key: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.mutations.execute(
        request.user,
        'update',
        params.publicId,
        body,
        key,
      ),
    };
  }
  @Post(':publicId/delete')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_DELETE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async remove(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Headers('idempotency-key') key: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.mutations.execute(
        request.user,
        'delete',
        params.publicId,
        body,
        key,
      ),
    };
  }
  @Post(':publicId/restore')
  @HttpCode(200)
  @RequireAdminPermissions(Permission.SPONSORED_POSTS_RESTORE)
  @Header('Cache-Control', 'no-store, max-age=0')
  async restore(
    @Param() params: SponsoredPostQueryParams,
    @Body() body: SponsoredVersionMutationDto,
    @Headers('idempotency-key') key: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.mutations.execute(
        request.user,
        'restore',
        params.publicId,
        body,
        key,
      ),
    };
  }
}
