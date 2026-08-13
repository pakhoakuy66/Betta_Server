import { type Types } from 'mongoose';
import {
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
  AdminBootstrapMode,
  AdminBootstrapOutcome,
} from '../constants/admin-bootstrap.constants';

export const ADMIN_BOOTSTRAP_SECRET_STORE = Symbol(
  'ADMIN_BOOTSTRAP_SECRET_STORE',
);

export type AdminBootstrapIdentity = Readonly<{
  email: string;
  username: string;
  displayName: string;
}>;

export type AdminBootstrapRequest = Readonly<{
  identity: AdminBootstrapIdentity;
  operatorReference: string;
  correlationId?: string;
  reissue: boolean;
}>;

export type AdminBootstrapResult = Readonly<{
  mode: AdminBootstrapMode;
  outcome: AdminBootstrapOutcome;
  adminPublicId?: string;
  secretReference?: string;
  expiresAt?: string;
}>;

export type AdminBootstrapGrantContext = Readonly<{
  purpose: AdminActivationGrantPurpose;
  targetPublicId: string;
  environment: AdminBootstrapEnvironment;
}>;

export type PutAdminBootstrapSecretInput = Readonly<{
  secretName: string;
  rawGrant: string;
  expiresAt: Date;
  context: AdminBootstrapGrantContext;
}>;

export interface AdminBootstrapSecretStore {
  assertReady(): void;
  putVersion(input: PutAdminBootstrapSecretInput): Promise<string>;
  revokeVersion(secretReference: string): Promise<void>;
}

export type StoredAdminBootstrapState = Readonly<{
  _id: Types.ObjectId;
  key: string;
  adminAccountId: Types.ObjectId;
  adminPublicId: string;
  purpose: AdminActivationGrantPurpose;
  environment: AdminBootstrapEnvironment;
  generation: number;
  grantHash: string;
  grantExpiresAt: Date;
  consumedAt?: Date | null;
  secretReference: string;
}>;
