import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { Types } from 'mongoose';
import { ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/access-support.constants';
import { applyAccessSupportPrivateHeaders } from '../../reports/utils/access-support-response.util';
import {
  AdminAuditActorType,
  AdminAuditSource,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { RequireAdminPermissions } from '../decorators/require-admin-permissions.decorator';
import {
  AdminAccessSupportContactParamDto,
  IssueAdminAccessSupportContactReauthDto,
  RevealAdminAccessSupportContactDto,
} from '../dto/admin-access-support-contact.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { type AdminAccessSupportContactActor } from '../interfaces/admin-access-support-contact.interface';
import { AdminAccessSupportContactService } from '../services/admin-access-support-contact.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { getAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';

@ApiTags('Admin Reports')
@ApiBearerAuth('access-token')
@Controller('admin/reports')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermissions(
  AdminPermission.REPORTS_VIEW,
  AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
)
export class AdminAccessSupportContactController {
  constructor(private readonly contacts: AdminAccessSupportContactService) {}

  @Post(':publicId/contact-reauth')
  @HttpCode(HttpStatus.OK)
  @ApiParam({
    name: 'publicId',
    schema: { pattern: ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Xác thực lại trước khi reveal contact hỗ trợ' })
  issueReauth(
    @Param() params: AdminAccessSupportContactParamDto,
    @Body() dto: IssueAdminAccessSupportContactReauthDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    applyAccessSupportPrivateHeaders(response);
    return this.contacts.issueReauth({
      actor: this.actor(request),
      reportPublicId: params.publicId,
      password: dto.password,
      totpToken: dto.totpToken,
      trustedClientIp: getAdminTrustedClientIp(request),
      source: AdminAuditSource.HTTP,
    });
  }

  @Post(':publicId/contact/reveal')
  @HttpCode(HttpStatus.OK)
  @ApiParam({
    name: 'publicId',
    schema: { pattern: ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN.source },
  })
  @ApiOperation({ summary: 'Reveal contact access-support một lần có audit' })
  reveal(
    @Param() params: AdminAccessSupportContactParamDto,
    @Body() dto: RevealAdminAccessSupportContactDto,
    @Req() request: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    applyAccessSupportPrivateHeaders(response);
    return this.contacts.reveal({
      actor: this.actor(request),
      reportPublicId: params.publicId,
      reauthGrant: dto.reauthGrant,
      reason: dto.reason,
      ...(dto.correlationId ? { correlationId: dto.correlationId } : {}),
      source: AdminAuditSource.HTTP,
    });
  }

  private actor(
    request: AdminAuthenticatedRequest,
  ): AdminAccessSupportContactActor {
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: new Types.ObjectId(request.user.adminAccountId),
      publicId: request.user.publicId,
      username: request.user.username,
      displayName: request.user.displayName,
      role: request.user.role,
      permission: AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
      permissionVersion: request.user.permissionVersion,
      sessionPublicId: request.user.sessionId,
      credentialVersion: request.user.credentialVersion,
      authzVersion: request.user.authzVersion,
    });
  }
}
