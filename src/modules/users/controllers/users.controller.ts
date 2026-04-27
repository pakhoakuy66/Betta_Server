import { Controller, Get, Body, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from '../services/users.service';
import { UpdateProfileDto } from '../dto/users.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Lấy thông tin cá nhân của người dùng bất kỳ' })
  @Get('profile/:username')
  async getProfile(@Param('username') username: string) {
    return this.usersService.getProfileByUsername(username);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cập nhật hồ sơ cá nhân (Yêu cầu đăng nhập)' })
  @UseGuards(AuthGuard('jwt'))
  @Patch('me')
  async updateMyProfile(
    @Request() req: any,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    // req.user._id được lấy ra nhờ tấm khiên AuthGuard kiểm tra Token
    const userId = req.user._id; 
    return this.usersService.updateProfile(userId, updateProfileDto);
  }
}
