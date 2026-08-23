import type { Types } from 'mongoose';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';

export type AdminUserRestrictionExpiryCandidate = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  fullname: string;
  version: number;
  restriction: Readonly<{
    type: UserRestrictionType.TEMPORARY_SUSPENSION;
    expiresAt: Date;
  }>;
}>;

export type AdminUserRestrictionExpiryResult = Readonly<{
  userPublicId: string;
  beforeVersion: number;
  afterVersion: number;
  authzVersion: number;
  revokedSessionCount: number;
}>;

export type AdminUserRestrictionExpiryBatchResult = Readonly<{
  scanned: number;
  expired: number;
  skipped: number;
  failed: number;
}>;
