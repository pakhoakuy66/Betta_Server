import {
  Body,
  Controller,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ReportsService } from '../services/reports.service';
import { ReportPostDto } from '../dto/report-post.dto';
import { ReportUserDto } from '../dto/report-user.dto';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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
