import {
  CanActivate,
  ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ACCESS_SUPPORT_BODY_MAX_BYTES } from '../constants/access-support.constants';

@Injectable()
export class AccessSupportBodyLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const contentLength = Number(request.get('content-length') ?? 0);

    if (
      Number.isFinite(contentLength) &&
      contentLength > ACCESS_SUPPORT_BODY_MAX_BYTES
    ) {
      throw new PayloadTooLargeException('Yêu cầu hỗ trợ vượt quá giới hạn');
    }

    const serialized = JSON.stringify(request.body ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > ACCESS_SUPPORT_BODY_MAX_BYTES) {
      throw new PayloadTooLargeException('Yêu cầu hỗ trợ vượt quá giới hạn');
    }

    return true;
  }
}
