import { type Types } from 'mongoose';
import {
  type PublicAdminSessionSummary,
  type PublicManagedAdminAccount,
} from '../interfaces/admin-account-query.interface';
import { type AdminAccount } from '../schemas/admin-account.schema';

export type ManagedAdminAccountSource = Pick<
  AdminAccount,
  | 'publicId'
  | 'email'
  | 'username'
  | 'displayName'
  | 'role'
  | 'status'
  | 'mfaStatus'
  | 'mustChangePassword'
  | 'version'
  | 'lockedAt'
  | 'deletedAt'
  | 'deletionOrigin'
  | 'createdAt'
  | 'updatedAt'
> &
  Readonly<{ _id: Types.ObjectId }>;

const toIsoOrNull = (value?: Date | null): string | null =>
  value instanceof Date ? value.toISOString() : null;

export const toPublicManagedAdminAccount = (
  account: ManagedAdminAccountSource,
  sessionSummary: PublicAdminSessionSummary,
): PublicManagedAdminAccount =>
  Object.freeze({
    id: account.publicId,
    publicId: account.publicId,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    mfaStatus: account.mfaStatus,
    mustChangePassword: account.mustChangePassword,
    version: account.version,
    sessionSummary: Object.freeze({ ...sessionSummary }),
    lockedAt: toIsoOrNull(account.lockedAt),
    deletedAt: toIsoOrNull(account.deletedAt),
    deletionOrigin: account.deletionOrigin ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  });
