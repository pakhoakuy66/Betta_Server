import { HttpException, HttpStatus } from '@nestjs/common';

export class ReportRateLimitException extends HttpException {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
