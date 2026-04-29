import {
  Controller,
  Post,
  Delete,
  Param,
  UseGuards,
  Request,
  Get,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RelationshipService } from '../services/relationship.service';

@ApiTags('Relationships (Followers)')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('relationships')
export class RelationshipController {
  constructor(private readonly relationshipService: RelationshipService) {}

  @ApiOperation({ summary: 'Theo dõi người dùng' })
  @Post('follow/:userId')
  async followUser(@Request() req: any, @Param('userId') targetUserId: string) {
    return this.relationshipService.followUser(req.user._id, targetUserId);
  }

  @ApiOperation({ summary: 'Lấy danh sách người theo dõi mình (Followers)' })
  @Get('followers/:userId')
  async getFollowers(
    @Param('userId') userId: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
  ) {
    return this.relationshipService.getFollowers(
      userId,
      parseInt(page) || 1,
      parseInt(limit) || 20,
    );
  }
  @ApiOperation({ summary: 'Lấy danh sách mình đang theo dõi (Following)' })
  @Get('following/:userId')
  async getFollowing(
    @Param('userId') userId: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
  ) {
    return this.relationshipService.getFollowing(
      userId,
      parseInt(page) || 1,
      parseInt(limit) || 20,
    );
  }

  @ApiOperation({ summary: 'Bỏ theo dõi một người dùng' })
  @Delete('unfollow/:userId')
  async unfollowUser(
    @Request() req: any,
    @Param('userId') targetUserId: string,
  ) {
    return this.relationshipService.unfollowUser(req.user._id, targetUserId);
  }
}
