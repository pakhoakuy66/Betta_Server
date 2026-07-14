import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ReportRateLimitException } from '../exceptions/report-rate-limit.exception';

@Catch(ReportRateLimitException)
export class ReportRateLimitExceptionFilter implements ExceptionFilter<ReportRateLimitException> {
  catch(exception: ReportRateLimitException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response.setHeader('Retry-After', String(exception.retryAfterSeconds));

    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
