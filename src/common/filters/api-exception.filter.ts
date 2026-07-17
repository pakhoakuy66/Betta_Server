import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorResponse } from '../interfaces/api-response.interface';

const BAD_REQUEST_STATUS = 400;
const NOT_FOUND_STATUS = 404;
const INTERNAL_SERVER_ERROR_STATUS = 500;
const SERVICE_UNAVAILABLE_STATUS = 503;

const ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeMessage = (value: unknown): string | string[] | undefined => {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (!Array.isArray(value)) return undefined;

  const messages = value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );

  return messages.length > 0 ? messages : undefined;
};

const normalizeRetryAfter = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;

const getPathname = (request: Request): string => {
  try {
    return new URL(request.originalUrl || request.url, 'http://localhost')
      .pathname;
  } catch {
    return (request.url || '/').split('?')[0];
  }
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();

    const statusCode: number =
      exception instanceof HttpException
        ? exception.getStatus()
        : INTERNAL_SERVER_ERROR_STATUS;

    const rawBody =
      exception instanceof HttpException ? exception.getResponse() : undefined;

    const body = isRecord(rawBody) ? rawBody : {};
    const normalizedMessage = normalizeMessage(
      typeof rawBody === 'string' ? rawBody : body.message,
    );

    const validationError =
      statusCode === BAD_REQUEST_STATUS && Array.isArray(normalizedMessage);

    const retryAfterSeconds = normalizeRetryAfter(body.retryAfterSeconds);

    const path = getPathname(request);

    const isDefaultRouteNotFound =
      statusCode === NOT_FOUND_STATUS &&
      typeof normalizedMessage === 'string' &&
      normalizedMessage.startsWith(`Cannot ${request.method.toUpperCase()} `);

    const safeMessage = isDefaultRouteNotFound
      ? 'Không tìm thấy tài nguyên'
      : normalizedMessage;

    const message =
      statusCode >= INTERNAL_SERVER_ERROR_STATUS
        ? statusCode === SERVICE_UNAVAILABLE_STATUS
          ? 'Dịch vụ tạm thời không khả dụng'
          : 'Đã xảy ra lỗi hệ thống'
        : (safeMessage ?? 'Yêu cầu không thể xử lý');

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    const result: ApiErrorResponse = {
      success: false,
      statusCode,
      error: validationError
        ? 'VALIDATION_ERROR'
        : (ERROR_CODES[statusCode] ?? 'HTTP_ERROR'),
      message,
      timestamp: new Date().toISOString(),
      path,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };

    if (statusCode >= INTERNAL_SERVER_ERROR_STATUS) {
      this.logger.error(
        `${request.method} ${path} ${statusCode}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(statusCode).json(result);
  }
}
