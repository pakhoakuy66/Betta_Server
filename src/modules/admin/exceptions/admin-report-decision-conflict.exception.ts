import { ConflictException } from '@nestjs/common';

export class AdminReportDecisionConflictException extends ConflictException {
  constructor(message: string) {
    super({
      error: 'REPORT_DECISION_CONFLICT',
      message,
    });
  }
}

export class AdminReportDecisionIdempotencyConflictException extends ConflictException {
  constructor() {
    super({
      error: 'REPORT_DECISION_IDEMPOTENCY_CONFLICT',
      message: 'Idempotency-Key đã được dùng cho payload khác',
    });
  }
}
