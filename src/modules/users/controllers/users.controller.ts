import { Controller, Get, Body, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from '../services/users.service';
import { UpdateProfileDto } from '../dto/users.dto';
import { OptionalJwtAuthGuard } from '../../auth/guards/optional-jwt.guard';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Lấy thông tin cá nhân của người dùng bất kỳ' })
  @UseGuards(OptionalJwtAuthGuard)
  @Get('profile/:username')
  async getProfile(@Request() req: any, @Param('username') username: string) {
    // Nếu người dùng có gửi Token (đã login), ta lấy ID của họ, nếu không thì để undefined
    const currentUserId = req.user?._id; 
    return this.usersService.getProfileByUsername(username, currentUserId);
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
