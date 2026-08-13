import { type Types } from 'mongoose';
import { type AdminAuthenticationResult } from './admin-auth.interface';

export type BeginAdminActivationInput = Readonly<{
  adminPublicId: string;
  activationGrant: string;
  trustedClientIp: string;
}>;

export type CompleteAdminActivationInput = Readonly<{
  adminPublicId: string;
  activationGrant: string;
  newPassword: string;
  confirmPassword: string;
  totpToken: string;
  trustedClientIp: string;
  userAgent?: string;
}>;

export type AdminActivationChallenge = Readonly<{
  admin: Readonly<{
    publicId: string;
    username: string;
    displayName: string;
  }>;
  secretBase32: string;
  otpauthUri: string;
  expiresAt: Date;
}>;

export type AdminActivationCompletion = Readonly<{
  authentication: AdminAuthenticationResult;
  recoveryCodes: readonly string[];
}>;

export type AdminActivationIdentity = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
}>;
