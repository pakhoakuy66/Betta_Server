import {
  AdminAccountStatus,
  AdminMfaStatus,
} from '../constants/admin-account.constants';

export interface AdminAccountStateCandidate {
  status: AdminAccountStatus;
  passwordHash?: string;
  mustChangePassword: boolean;
  mfaStatus: AdminMfaStatus;
  encryptedTotpSecret?: string;
  pendingEncryptedTotpSecret?: string;
  pendingTotpEnrollmentExpiresAt?: Date;
  activationGrantHash?: string;
  activationGrantExpiresAt?: Date;
  activationGrantConsumedAt?: Date | null;
}

export interface AdminAccountStateViolation {
  path: keyof AdminAccountStateCandidate;
  message: string;
}

export class AdminAccountStateInvariantError extends Error {
  constructor(
    public readonly violations: readonly AdminAccountStateViolation[],
  ) {
    super(violations.map(({ message }) => message).join('; '));
    this.name = AdminAccountStateInvariantError.name;
  }
}

const isPresentString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

export function assertAdminAccountState(
  candidate: AdminAccountStateCandidate,
): void {
  const violations: AdminAccountStateViolation[] = [];
  const hasGrantHash = isPresentString(candidate.activationGrantHash);
  const hasGrantExpiry = isValidDate(candidate.activationGrantExpiresAt);
  const hasConsumedAt = isValidDate(candidate.activationGrantConsumedAt);
  const hasPendingTotpSecret = isPresentString(
    candidate.pendingEncryptedTotpSecret,
  );
  const hasPendingTotpExpiry = isValidDate(
    candidate.pendingTotpEnrollmentExpiresAt,
  );

  if (hasPendingTotpSecret !== hasPendingTotpExpiry) {
    violations.push({
      path: 'pendingEncryptedTotpSecret',
      message: 'TOTP enrollment secret và expiry phải cùng tồn tại',
    });
  }

  if (
    candidate.mfaStatus === AdminMfaStatus.PENDING_ENROLLMENT &&
    (!hasPendingTotpSecret || !hasPendingTotpExpiry)
  ) {
    violations.push({
      path: 'mfaStatus',
      message: 'Admin pending MFA phải có enrollment challenge hữu hạn',
    });
  }

  if (hasGrantHash !== hasGrantExpiry) {
    violations.push({
      path: 'activationGrantHash',
      message: 'Activation grant hash và expiry phải cùng tồn tại',
    });
  }

  if (hasConsumedAt && (hasGrantHash || hasGrantExpiry)) {
    violations.push({
      path: 'activationGrantConsumedAt',
      message: 'Activation grant đã consume không được giữ hash hoặc expiry',
    });
  }

  if (
    candidate.status === AdminAccountStatus.PENDING_ACTIVATION &&
    (!hasGrantHash || !hasGrantExpiry || hasConsumedAt)
  ) {
    violations.push({
      path: 'status',
      message: 'Admin pending activation phải có grant chưa được consume',
    });
  }

  if (candidate.status === AdminAccountStatus.ACTIVE) {
    if (!isPresentString(candidate.passwordHash)) {
      violations.push({
        path: 'passwordHash',
        message: 'Admin active phải có password hash',
      });
    }

    if (
      candidate.mustChangePassword ||
      candidate.mfaStatus !== AdminMfaStatus.ACTIVE ||
      !isPresentString(candidate.encryptedTotpSecret)
    ) {
      violations.push({
        path: 'status',
        message: 'Admin chỉ active sau khi đổi mật khẩu và kích hoạt MFA',
      });
    }

    if (hasGrantHash || hasGrantExpiry || !hasConsumedAt) {
      violations.push({
        path: 'activationGrantConsumedAt',
        message: 'Admin active phải hoàn tất và xóa credential activation',
      });
    }
  }

  if (violations.length > 0) {
    throw new AdminAccountStateInvariantError(violations);
  }
}
