import {
  Body,
  Controller,
  Header,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Transform } from 'class-transformer';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequireAdminPermissions } from '../admin/decorators/require-admin-permissions.decorator';
import { AdminPermission } from '../admin/constants/admin-permission.constants';
import type { AdminAuthenticatedRequest } from '../admin/types/admin-authenticated-request';
import { SPONSORED_PUBLIC_ID_PATTERN } from './sponsored-post.constants';
import {
  SPONSORED_MEDIA_LIMITS,
  type SponsoredUpload,
} from './sponsored-media.policy';
import { SponsoredMediaService } from './sponsored-media.service';
export class SponsoredMediaParams {
  @IsString() @Matches(SPONSORED_PUBLIC_ID_PATTERN) publicId!: string;
}
export class SponsoredMediaBody {
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number') return value;

    return typeof value === 'string' && /^(0|[1-9]\d{0,4})$/u.test(value)
      ? Number(value)
      : Number.NaN;
  })
  @IsInt()
  @Min(0)
  @Max(99999)
  expectedVersion!: number;
}
@Controller('admin/sponsored-posts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class SponsoredMediaController {
  constructor(private readonly media: SponsoredMediaService) {}
  @Post(':publicId/media')
  @RequireAdminPermissions(AdminPermission.SPONSORED_POSTS_UPDATE)
  @Header('Cache-Control', 'no-store, max-age=0')
  @UseInterceptors(
    FilesInterceptor('images', 3, {
      limits: {
        files: 3,
        fileSize: SPONSORED_MEDIA_LIMITS.bytes,
        fields: 1,
        parts: 4,
        fieldSize: 20,
      },
    }),
  )
  async replace(
    @Param() params: SponsoredMediaParams,
    @Body() body: SponsoredMediaBody,
    @UploadedFiles() files: SponsoredUpload[],
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return {
      success: true,
      data: await this.media.replace(
        request.user,
        params.publicId,
        body.expectedVersion,
        files,
      ),
    };
  }
}
