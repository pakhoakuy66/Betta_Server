import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ReportRateLimitService } from '../services/report-rate-limit.service';
import { getRequestIp, type ReportRequest } from '../utils/request-ip.util';

@Injectable()
export class ReportIssueUploadRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimitService: ReportRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ReportRequest>();

    const userId = request.user?._id;

    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    await this.rateLimitService.consumeSystemUpload({
      reporterId: new Types.ObjectId(userId),
      clientIp: getRequestIp(request),
    });

    return true;
  }
}
