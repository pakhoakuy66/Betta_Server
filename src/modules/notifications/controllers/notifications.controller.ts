import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { NotificationsQueryDto } from '../dto/notifications-query.dto';
import { NotificationsService } from '../services/notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiOperation({ summary: 'Lấy danh sách thông báo của user hiện tại' })
  @Get()
  getNotifications(
    @Request() req: AuthenticatedRequest,
    @Query() query: NotificationsQueryDto,
  ) {
    return this.notificationsService.getNotifications(req.user._id, query);
  }

  @ApiOperation({ summary: 'Lấy số lượng thông báo chưa đọc' })
  @Get('unread-count')
  getUnreadCount(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.getUnreadCount(req.user._id);
  }

  @ApiOperation({ summary: 'Đánh dấu tất cả thông báo là đã đọc' })
  @Patch('read-all')
  markAllAsRead(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.markAllAsRead(req.user._id);
  }

  @ApiOperation({ summary: 'Đánh dấu một thông báo là đã đọc' })
  @Patch(':id/read')
  markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(req.user._id, notificationId);
  }
}
