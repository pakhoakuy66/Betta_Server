import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { GetMyStreakHistoryQueryDto } from '../dto/streak.dto';
import { StreakService } from '../services/streak.service';

@Controller('streak')
@UseGuards(AuthGuard('jwt'))
export class StreakController {
  constructor(private readonly streakService: StreakService) {}

  @Get('me/history')
  getMyStreakHistory(
    @Req() req: AuthenticatedRequest,
    @Query() query: GetMyStreakHistoryQueryDto,
  ) {
    return this.streakService.getMyStreakHistory(req.user._id, query.limit);
  }
}
