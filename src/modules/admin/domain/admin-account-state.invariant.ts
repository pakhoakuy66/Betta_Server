import {
  AdminAccountDeletionOrigin,
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
  lockedAt?: Date | null;
  deletedAt?: Date | null;
  deletionOrigin?: AdminAccountDeletionOrigin | null;
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
  const hasLockedAt = isValidDate(candidate.lockedAt);
  const hasDeletedAt = isValidDate(candidate.deletedAt);
  const hasDeletionOrigin =
    candidate.deletionOrigin === AdminAccountDeletionOrigin.ADMIN;
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

  const isActivatedStatus =
    candidate.status === AdminAccountStatus.ACTIVE ||
    candidate.status === AdminAccountStatus.LOCKED ||
    candidate.status === AdminAccountStatus.SOFT_DELETED;

  if (
    candidate.status === AdminAccountStatus.SOFT_DELETED &&
    (!hasDeletedAt || !hasDeletionOrigin)
  ) {
    violations.push({
      path: 'deletionOrigin',
      message: 'Admin xóa mềm phải có thời điểm và nguồn xóa quản trị',
    });
  }

  if (
    candidate.status !== AdminAccountStatus.SOFT_DELETED &&
    (hasDeletedAt || candidate.deletionOrigin != null)
  ) {
    violations.push({
      path: 'deletedAt',
      message: 'Admin chưa xóa không được giữ metadata xóa mềm',
    });
  }

  if (candidate.status === AdminAccountStatus.LOCKED && !hasLockedAt) {
    violations.push({
      path: 'lockedAt',
      message: 'Admin bị khóa phải có thời điểm khóa',
    });
  }

  if (candidate.status === AdminAccountStatus.ACTIVE && hasLockedAt) {
    violations.push({
      path: 'lockedAt',
      message: 'Admin active không được giữ thời điểm khóa',
    });
  }

  if (candidate.status === AdminAccountStatus.SOFT_DELETED && hasLockedAt) {
    violations.push({
      path: 'lockedAt',
      message: 'Admin xóa mềm không được đồng thời giữ trạng thái khóa',
    });
  }

  if (isActivatedStatus) {
    if (!isPresentString(candidate.passwordHash)) {
      violations.push({
        path: 'passwordHash',
        message: 'Admin đã activation phải có password hash',
      });
    }

    const isAuthenticatedState =
      !candidate.mustChangePassword &&
      candidate.mfaStatus === AdminMfaStatus.ACTIVE &&
      isPresentString(candidate.encryptedTotpSecret) &&
      !hasPendingTotpSecret;
    const isResetRequiredState =
      candidate.mfaStatus === AdminMfaStatus.RESET_REQUIRED &&
      !isPresentString(candidate.encryptedTotpSecret) &&
      !hasPendingTotpSecret;
    const isRecoveryEnrollmentState =
      !candidate.mustChangePassword &&
      candidate.mfaStatus === AdminMfaStatus.PENDING_ENROLLMENT &&
      !isPresentString(candidate.encryptedTotpSecret) &&
      hasPendingTotpSecret &&
      hasPendingTotpExpiry;

    if (
      !isAuthenticatedState &&
      !isResetRequiredState &&
      !isRecoveryEnrollmentState
    ) {
      violations.push({
        path: 'status',
        message:
          'Admin đã activation phải ở trạng thái xác thực hoặc recovery được kiểm soát',
      });
    }

    if (hasGrantHash || hasGrantExpiry || !hasConsumedAt) {
      violations.push({
        path: 'activationGrantConsumedAt',
        message:
          'Admin đã activation phải hoàn tất và xóa credential activation',
      });
    }
  }

  if (violations.length > 0) {
    throw new AdminAccountStateInvariantError(violations);
  }
}
