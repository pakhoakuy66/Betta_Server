import {
  Body,
  Controller,
  Headers,
  Param,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Types } from 'mongoose';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN,
  AdminPostModerationOperation,
} from '../constants/admin-post-moderation.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import { AdminPostPublicIdParamDto } from '../dto/admin-post-public-id.dto';
import {
  HideAdminPostDto,
  RestoreAdminPostDto,
  TerminalDeleteAdminPostDto,
} from '../dto/update-admin-post-moderation.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import type { AdminPostModerationActor } from '../interfaces/admin-post-moderation.interface';
import { AdminPostModerationService } from '../services/admin-post-moderation.service';
import type { AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { POST_PUBLIC_ID_PATTERN } from '../../posts/utils/generate-post-public-id';

@ApiTags('Admin Posts')
@ApiBearerAuth('access-token')
@Controller('admin/posts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class AdminPostModerationController {
  constructor(private readonly moderation: AdminPostModerationService) {}

  @Patch(':publicId/hide')
  @RequireAdminPermissions(AdminPermission.POSTS_HIDE)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: POST_PUBLIC_ID_PATTERN.source },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      pattern: ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOperation({ summary: 'Ẩn Post bằng optimistic concurrency' })
  hide(
    @Param() params: AdminPostPublicIdParamDto,
    @Body() dto: HideAdminPostDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.moderation.update(
      this.input(
        params.publicId,
        AdminPostModerationOperation.HIDE,
        dto,
        idempotencyKey,
        request,
        AdminPermission.POSTS_HIDE,
      ),
    );
  }

  @Patch(':publicId/restore')
  @RequireAdminPermissions(AdminPermission.POSTS_RESTORE)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: POST_PUBLIC_ID_PATTERN.source },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      pattern: ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOperation({ summary: 'Khôi phục Post hidden còn đủ điều kiện' })
  restore(
    @Param() params: AdminPostPublicIdParamDto,
    @Body() dto: RestoreAdminPostDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.moderation.update(
      this.input(
        params.publicId,
        AdminPostModerationOperation.RESTORE,
        dto,
        idempotencyKey,
        request,
        AdminPermission.POSTS_RESTORE,
      ),
    );
  }

  @Patch(':publicId/terminal-delete')
  @RequireAdminPermissions(AdminPermission.POSTS_DELETE)
  @ApiParam({
    name: 'publicId',
    schema: { type: 'string', pattern: POST_PUBLIC_ID_PATTERN.source },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      pattern: ADMIN_POST_MODERATION_IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOperation({ summary: 'Terminal delete Post và yêu cầu cleanup async' })
  terminalDelete(
    @Param() params: AdminPostPublicIdParamDto,
    @Body() dto: TerminalDeleteAdminPostDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.moderation.update(
      this.input(
        params.publicId,
        AdminPostModerationOperation.TERMINAL_DELETE,
        dto,
        idempotencyKey,
        request,
        AdminPermission.POSTS_DELETE,
      ),
    );
  }

  private input(
    postPublicId: string,
    operation: AdminPostModerationOperation,
    dto: HideAdminPostDto | RestoreAdminPostDto | TerminalDeleteAdminPostDto,
    idempotencyKey: string,
    request: AdminAuthenticatedRequest,
    permission: AdminPermission,
  ) {
    return Object.freeze({
      actor: this.actor(request, permission),
      postPublicId,
      operation,
      expectedModerationVersion: dto.expectedModerationVersion,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      correlationId: dto.correlationId,
      idempotencyKey,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
    permission: AdminPermission,
  ): AdminPostModerationActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission,
      permissionVersion: request.user.permissionVersion,
      sessionPublicId: request.user.sessionId,
      credentialVersion: request.user.credentialVersion,
      authzVersion: request.user.authzVersion,
    });
  }

  private noStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
