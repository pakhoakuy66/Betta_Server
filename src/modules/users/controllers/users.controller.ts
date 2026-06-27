import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Request,
  UploadedFile,
  UseInterceptors,
  Delete,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from '../services/users.service';
import { SearchUsersQueryDto, UpdateProfileDto } from '../dto/users.dto';
import { OptionalJwtAuthGuard } from '../../auth/guards/optional-jwt.guard';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '../../../common/types/authenticated-request';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Tìm kiếm người dùng theo username' })
  @UseGuards(AuthGuard('jwt'))
  @Get('search')
  async searchUsers(
    @Request() req: AuthenticatedRequest,
    @Query() query: SearchUsersQueryDto,
  ) {
    return this.usersService.searchUsers(req.user._id, query);
  }

  @ApiOperation({ summary: 'Lấy thông tin cá nhân của người dùng bất kỳ' })
  @UseGuards(OptionalJwtAuthGuard)
  @Get('profile/:username')
  async getProfile(
    @Request() req: OptionalAuthenticatedRequest,
    @Param('username') username: string,
  ) {
    // Nếu người dùng có gửi Token (đã login), ta lấy ID của họ, nếu không thì để undefined
    const currentUserId = req.user?._id;
    return this.usersService.getProfileByUsername(username, currentUserId);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cập nhật hồ sơ cá nhân (Yêu cầu đăng nhập)' })
  @UseGuards(AuthGuard('jwt'))
  @Patch('me')
  async updateMyProfile(
    @Request() req: AuthenticatedRequest,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    // req.user._id được lấy ra nhờ tấm khiên AuthGuard kiểm tra Token
    const userId = req.user._id;
    return this.usersService.updateProfile(userId, updateProfileDto);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cập nhật avatar của chính mình' })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  @Patch('me/avatar')
  async updateMyAvatar(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file?: UploadFile,
  ) {
    return this.usersService.updateAvatar(req.user._id, file);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Xóa avatar của chính mình' })
  @UseGuards(AuthGuard('jwt'))
  @Delete('me/avatar')
  async removeMyAvatar(@Request() req: AuthenticatedRequest) {
    return this.usersService.removeAvatar(req.user._id);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Người dùng tự xóa mềm tài khoản của chính mình' })
  @UseGuards(AuthGuard('jwt'))
  @Delete('me') // Đường dẫn API sẽ là: DELETE /users/me
  async deleteMyAccount(@Request() req: AuthenticatedRequest) {
    const userId = req.user._id; // Tự động lấy ID của chính họ từ JWT Token sau khi đăng nhập
    return this.usersService.softDeleteUser(userId);
  }

  // @ApiOperation({
  //   summary: 'Admin thực hiện xóa mềm/banned tài khoản user khác',
  // })
  // // @UseGuards(AdminGuard) // Nếu sau này bạn có viết file bảo vệ quyền Admin thì mở dòng này ra
  // @Delete(':id') // Đường dẫn API sẽ là: DELETE /users/ID_CỦA_USER_CẦN_XÓA
  // async deleteUserByAdmin(@Param('id') userId: string) {
  //   return this.usersService.softDeleteUser(userId);
  // }
}
