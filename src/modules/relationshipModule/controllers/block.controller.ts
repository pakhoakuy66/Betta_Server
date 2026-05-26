import { Controller, Post, Delete, Get, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { BlockService } from '../services/block.service';

@ApiTags('Relationships (Block)')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('blocks')
export class BlockController {
  constructor(private readonly blockService: BlockService) {}

  @ApiOperation({ summary: 'Chặn một người dùng' })
  @Post(':userId')
  async blockUser(@Request() req: any, @Param('userId') targetUserId: string) {
    return this.blockService.blockUser(req.user._id, targetUserId);
  }

  @ApiOperation({ summary: 'Bỏ chặn người dùng' })
  @Delete(':userId')
  async unblockUser(@Request() req: any, @Param('userId') targetUserId: string) {
    return this.blockService.unblockUser(req.user._id, targetUserId);
  }

  @ApiOperation({ summary: 'Lấy danh sách người đã bị chặn' })
  @Get('list')
  async getBlockedUsers(@Request() req: any) {
    return this.blockService.getBlockedUsers(req.user._id);
  }
}
