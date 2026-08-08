import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { type AdminAccount } from '../schemas/admin-account.schema';

export interface PublicAdminAccount {
  id: string;
  publicId: string;
  email: string;
  username: string;
  displayName: string;
  role: AdminRole;
  status: AdminAccountStatus;
  mfaStatus: AdminMfaStatus;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type PublicAdminAccountSource = Pick<
  AdminAccount,
  | 'publicId'
  | 'email'
  | 'username'
  | 'displayName'
  | 'role'
  | 'status'
  | 'mfaStatus'
  | 'mustChangePassword'
  | 'createdAt'
  | 'updatedAt'
>;

export function toPublicAdminAccount(
  account: PublicAdminAccountSource,
): PublicAdminAccount {
  return {
    id: account.publicId,
    publicId: account.publicId,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    mfaStatus: account.mfaStatus,
    mustChangePassword: account.mustChangePassword,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
