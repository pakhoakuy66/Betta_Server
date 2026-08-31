import { ConflictException } from '@nestjs/common';
import {
  REPORT_ASSIGNMENT_CONFLICT_ERROR,
  REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT_ERROR,
  type PublicReportAssignmentConflictState,
} from '../../../common/security/public-report-assignment-conflict';

export class AdminReportAssignmentConflictException extends ConflictException {
  constructor(
    message: string,
    currentAssignment: PublicReportAssignmentConflictState,
  ) {
    super({
      error: REPORT_ASSIGNMENT_CONFLICT_ERROR,
      message,
      currentAssignment,
    });
  }
}

export class AdminReportAssignmentIdempotencyConflictException extends ConflictException {
  constructor() {
    super({
      error: REPORT_ASSIGNMENT_IDEMPOTENCY_CONFLICT_ERROR,
      message: 'Idempotency-Key đã được dùng cho payload khác',
    });
  }
}
