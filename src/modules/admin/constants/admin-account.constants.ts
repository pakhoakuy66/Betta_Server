export enum AdminRole {
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum AdminAccountStatus {
  PENDING_ACTIVATION = 'PENDING_ACTIVATION',
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  SOFT_DELETED = 'SOFT_DELETED',
}

export enum AdminAccountDeletionOrigin {
  ADMIN = 'ADMIN',
}

export enum AdminMfaStatus {
  NOT_ENROLLED = 'NOT_ENROLLED',
  PENDING_ENROLLMENT = 'PENDING_ENROLLMENT',
  ACTIVE = 'ACTIVE',
  RESET_REQUIRED = 'RESET_REQUIRED',
}
