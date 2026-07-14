import {
  Body,
  Controller,
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

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post('issues')
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
