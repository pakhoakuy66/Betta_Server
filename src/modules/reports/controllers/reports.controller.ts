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
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Issue
  @Post('issues')
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
    @Request() req: AuthenticatedRequest,
    @Body() dto: ReportIssueDto,
    @UploadedFiles() files: UploadFile[] = [],
  ) {
    return this.reportsService.reportIssue(req.user._id, dto, files);
  }

  // Post
  @Post('posts/:publicId')
  @ApiOperation({ summary: 'Báo cáo bài viết theo publicId' })
  reportPost(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ReportPostDto,
  ) {
    return this.reportsService.reportPost(req.user._id, publicId, dto);
  }

  // User
  @Post('users/:publicId')
  @ApiOperation({ summary: 'Báo cáo tài khoản theo publicId' })
  reportUser(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ReportUserDto,
  ) {
    return this.reportsService.reportUser(req.user._id, publicId, dto);
  }
}
