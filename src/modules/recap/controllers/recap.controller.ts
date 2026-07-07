import {
  Controller,
  Get,
  Param,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { RecapService } from '../services/recap.service';

@ApiTags('Recap')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('recap')
export class RecapController {
  constructor(private readonly recapService: RecapService) {}

  @ApiOperation({ summary: 'Lấy Weekly Recap mới nhất của user hiện tại' })
  @Get('me/latest')
  getLatestRecap(@Request() req: AuthenticatedRequest) {
    return this.recapService.getLatestRecapForUser(req.user._id);
  }

  @ApiOperation({ summary: 'Đánh dấu Weekly Recap là đã xem' })
  @Patch(':id/seen')
  markRecapAsSeen(
    @Request() req: AuthenticatedRequest,
    @Param('id') recapId: string,
  ) {
    return this.recapService.markRecapAsSeen(req.user._id, recapId);
  }
}
