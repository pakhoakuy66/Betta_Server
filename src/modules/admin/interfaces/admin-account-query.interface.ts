import {
  type AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';

export type AdminAccountListQuery = Readonly<{
  page: number;
  limit: number;
  role?: AdminRole;
  status?: AdminAccountStatus;
  mfaStatus?: AdminMfaStatus;
  search?: string;
}>;

export type PublicAdminSessionSummary = Readonly<{
  activeCount: number;
  lastActiveAt: string | null;
}>;

export type PublicManagedAdminAccount = Readonly<{
  id: string;
  publicId: string;
  email: string;
  username: string;
  displayName: string;
  role: AdminRole;
  status: AdminAccountStatus;
  mfaStatus: AdminMfaStatus;
  mustChangePassword: boolean;
  version: number;
  sessionSummary: PublicAdminSessionSummary;
  lockedAt: string | null;
  deletedAt: string | null;
  deletionOrigin: AdminAccountDeletionOrigin | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminAccountPage = Readonly<{
  items: readonly PublicManagedAdminAccount[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
