import type { PublicAccountRestriction } from '../security/public-account-restriction';
import type { PublicReportAssignmentConflictState } from '../security/public-report-assignment-conflict';
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T | null;
  message?: string;
  meta?: unknown;
  pagination?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
  retryAfterSeconds?: number;
  publicRestriction?: PublicAccountRestriction;
  currentAssignment?: PublicReportAssignmentConflictState;
  challenge?: {
    token: string;
    difficultyBits: number;
    expiresAt: string;
  };
}

export const createSuccessResponse = <T>(
  data: T | null,
  message?: string,
): ApiSuccessResponse<T> => ({
  success: true,
  ...(message ? { message } : {}),
  data,
});
