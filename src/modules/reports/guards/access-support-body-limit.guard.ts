import {
  CanActivate,
  ExecutionContext,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ACCESS_SUPPORT_BODY_MAX_BYTES,
  ACCESS_SUPPORT_CHALLENGE_HEADER,
  ACCESS_SUPPORT_CONTENT_TYPE,
  ACCESS_SUPPORT_ROUTE_CHALLENGE_FINGERPRINT,
} from '../constants/access-support.constants';
import { AccessSupportRateLimitService } from '../services/access-support-rate-limit.service';
import {
  type AccessSupportAttemptRequest,
  hasAccessSupportIpAttempt,
  markAccessSupportIpAttempt,
} from '../utils/access-support-attempt.util';
import { getRequestIp } from '../utils/request-ip.util';
import { applyAccessSupportPrivateHeaders } from '../utils/access-support-response.util';

@Injectable()
export class AccessSupportBodyLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: AccessSupportRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AccessSupportAttemptRequest>();
    const response = http.getResponse<Response>();
    applyAccessSupportPrivateHeaders(response);

    if (!hasAccessSupportIpAttempt(request)) {
      await this.rateLimit.consumeIp(
        getRequestIp(request),
        ACCESS_SUPPORT_ROUTE_CHALLENGE_FINGERPRINT,
        request.get(ACCESS_SUPPORT_CHALLENGE_HEADER),
      );
      markAccessSupportIpAttempt(request);
    }

    const contentType = (request.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== ACCESS_SUPPORT_CONTENT_TYPE) {
      throw new UnsupportedMediaTypeException(
        'Yêu cầu hỗ trợ chỉ chấp nhận JSON',
      );
    }

    if (!Buffer.isBuffer(request.rawBody)) {
      throw new ServiceUnavailableException(
        'Không thể xác minh kích thước yêu cầu hỗ trợ',
      );
    }

    if (request.rawBody.length > ACCESS_SUPPORT_BODY_MAX_BYTES) {
      throw new PayloadTooLargeException('Yêu cầu hỗ trợ vượt quá giới hạn');
    }

    return true;
  }
}
