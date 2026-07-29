import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_API_RESPONSE_ENVELOPE } from '../decorators/skip-api-response-envelope.decorator';
import type { ApiSuccessResponse } from '../interfaces/api-response.interface';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.hasOwn(value, key);

const LEGACY_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'success',
  'message',
  'meta',
  'pagination',
]);

const extractLegacyData = (
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const data: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!LEGACY_ENVELOPE_KEYS.has(key)) {
      data[key] = value;
    }
  }

  return data;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !Buffer.isBuffer(value) &&
  !(value instanceof StreamableFile);

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor<
  unknown,
  unknown
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const shouldSkip = this.reflector.getAllAndOverride<boolean>(
      SKIP_API_RESPONSE_ENVELOPE,
      [context.getHandler(), context.getClass()],
    );

    if (shouldSkip) return next.handle();

    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((payload) => {
        if (
          response.statusCode === 204 ||
          Buffer.isBuffer(payload) ||
          payload instanceof StreamableFile
        ) {
          return payload;
        }

        return this.normalize(payload);
      }),
    );
  }

  private normalize(payload: unknown): ApiSuccessResponse {
    if (isRecord(payload) && payload.success === false) {
      throw new InternalServerErrorException(
        'Controller không được trả success=false với HTTP 2xx',
      );
    }

    if (isRecord(payload) && payload.success === true) {
      const message =
        typeof payload.message === 'string' ? payload.message : undefined;

      if (hasOwn(payload, 'data')) {
        return {
          success: true,
          ...(message ? { message } : {}),
          data: payload.data ?? null,
          ...(hasOwn(payload, 'meta') ? { meta: payload.meta } : {}),
          ...(hasOwn(payload, 'pagination')
            ? { pagination: payload.pagination }
            : {}),
        };
      }

      const legacyData = extractLegacyData(payload);

      return {
        success: true,
        ...(message ? { message } : {}),
        data: Object.keys(legacyData).length > 0 ? legacyData : null,
        ...(hasOwn(payload, 'meta') ? { meta: payload.meta } : {}),
        ...(hasOwn(payload, 'pagination')
          ? { pagination: payload.pagination }
          : {}),
      };
    }

    if (
      isRecord(payload) &&
      Object.keys(payload).length === 1 &&
      typeof payload.message === 'string'
    ) {
      return {
        success: true,
        message: payload.message,
        data: null,
      };
    }

    return {
      success: true,
      data: payload ?? null,
    };
  }
}
