import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ReportsService } from '../services/reports.service';
import { ReportPostDto } from '../dto/report-post.dto';
import { ReportUserDto } from '../dto/report-user.dto';
import { ReportIssueDto } from '../dto/report-issue.dto';
import { ReportIssueUploadRateLimitGuard } from '../guards/report-issue-upload-rate-limit.guard';
import { getRequestIp, type ReportRequest } from '../utils/request-ip.util';
import { AccessSupportRequestDto } from '../dto/access-support-request.dto';
import { AccessSupportBodyLimitGuard } from '../guards/access-support-body-limit.guard';
import { AccessSupportService } from '../services/access-support.service';
import {
  type AccessSupportAttemptRequest,
  hasAccessSupportIpAttempt,
} from '../utils/access-support-attempt.util';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly accessSupportService: AccessSupportService,
  ) {}

  @Post('access-issues')
  @UseGuards(AccessSupportBodyLimitGuard)
  @ApiOperation({ summary: 'Gửi yêu cầu hỗ trợ truy cập tài khoản' })
  reportAccessIssue(
    @Request() request: AccessSupportAttemptRequest,
    @Body() dto: AccessSupportRequestDto,
    @Headers('x-access-support-challenge') challenge?: string,
  ) {
    return this.accessSupportService.submit(
      dto,
      getRequestIp(request),
      challenge,
      hasAccessSupportIpAttempt(request),
    );
  }

  @Post('issues')
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('jwt'), ReportIssueUploadRateLimitGuard)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Báo cáo sự cố hệ thống' })
  @UseInterceptors(
    FilesInterceptor('evidence', 3, {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 3,
      },
    }),
  )
  reportIssue(
    @Request() request: ReportRequest,
    @Body() dto: ReportIssueDto,
    @UploadedFiles() files: UploadFile[] = [],
  ) {
    return this.reportsService.reportIssue(
      request.user._id,
      dto,
      files,
      getRequestIp(request),
    );
  }

  @Post('posts/:publicId')
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Báo cáo bài viết theo publicId' })
  reportPost(
    @Request() request: ReportRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ReportPostDto,
  ) {
    return this.reportsService.reportPost(
      request.user._id,
      publicId,
      dto,
      getRequestIp(request),
    );
  }

  @Post('users/:publicId')
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Báo cáo tài khoản theo publicId' })
  reportUser(
    @Request() request: ReportRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ReportUserDto,
  ) {
    return this.reportsService.reportUser(
      request.user._id,
      publicId,
      dto,
      getRequestIp(request),
    );
  }
}
