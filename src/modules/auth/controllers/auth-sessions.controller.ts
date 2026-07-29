import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { createSuccessResponse } from '../../../common/interfaces/api-response.interface';
import {
  ApiStandardErrors,
  ApiStandardSuccess,
} from '../../../common/decorators/api-standard-response.decorator';
import {
  AuthSessionListResponseDto,
  ListAuthSessionsQueryDto,
  RevokeAuthSessionParamsDto,
} from '../dto/auth-session.dto';
import { AuthSessionService } from '../services/auth-session.service';

@ApiTags('Authentication Sessions')
@ApiBearerAuth('access-token')
@ApiStandardErrors()
@UseGuards(AuthGuard('jwt'))
@Controller('auth')
export class AuthSessionsController {
  constructor(private readonly authSessionService: AuthSessionService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Xem các phiên đăng nhập đang hoạt động' })
  @ApiOkResponse({ type: AuthSessionListResponseDto })
  async listSessions(
    @Request() request: AuthenticatedRequest,
    @Query() query: ListAuthSessionsQueryDto,
  ) {
    const result = await this.authSessionService.listActiveSessions(
      request.user._id,
      request.user.sessionId,
      query.page,
      query.limit,
    );

    return {
      success: true as const,
      data: result.items,
      pagination: result.pagination,
    };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Thu hồi một phiên đăng nhập khác' })
  @ApiStandardSuccess()
  @ApiNotFoundResponse({
    description: 'Phiên không tồn tại hoặc không thuộc người dùng',
  })
  async revokeSession(
    @Request() request: AuthenticatedRequest,
    @Param() params: RevokeAuthSessionParamsDto,
  ) {
    await this.authSessionService.revokeOtherSession(
      request.user._id,
      params.sessionId,
      request.user.sessionId,
    );

    return createSuccessResponse(null, 'Đã đăng xuất phiên được chọn');
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đăng xuất khỏi tất cả thiết bị' })
  @ApiStandardSuccess()
  async logoutAll(@Request() request: AuthenticatedRequest) {
    await this.authSessionService.logoutAllSessions(request.user._id);

    return createSuccessResponse(null, 'Đã đăng xuất khỏi tất cả thiết bị');
  }
}
