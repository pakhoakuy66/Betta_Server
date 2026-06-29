import {
  Body,
  Controller,
  Delete,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { ReactPostDto } from '../dto/react-post.dto';
import { ReactionService } from '../services/reaction.service';

@ApiTags('Reactions')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('posts/:publicId/reaction')
export class ReactionController {
  constructor(private readonly reactionService: ReactionService) {}

  @ApiOperation({ summary: 'Reaction bài viết bằng publicId' })
  @Put()
  async reactToPost(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ReactPostDto,
  ) {
    return this.reactionService.reactToPost(req.user._id, publicId, dto);
  }

  @ApiOperation({ summary: 'Hủy reaction bài viết bằng publicId' })
  @Delete()
  async removeReaction(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.reactionService.removeReaction(req.user._id, publicId);
  }
}
