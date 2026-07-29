import type { Types } from 'mongoose';

export type IssuedGoogleOAuthContinuationGrant = {
  rawGrant: string;
  expiresAt: Date;
};

/**
 * Internal-only input assembled from a verified Google identity
 * and an internal account-link resolution.
 *
 * Never construct this input from a public DTO, request body,
 * query parameter or frontend-provided identity data.
 */
export type IssueGoogleOAuthLinkGrantInput = {
  providerAccountId: string;
  email: string;
  targetUserId: Types.ObjectId;
};

/**
 * Internal-only input assembled from a verified Google identity
 * and an internal registration resolution.
 *
 * Never construct this input from public request data.
 */
export type IssueGoogleOAuthRegistrationGrantInput = {
  providerAccountId: string;
  email: string;
  fullname: string | null;
  avatar: string | null;
};

export type ConsumedGoogleOAuthLinkGrant = {
  providerAccountId: string;
  email: string;
  targetUserId: Types.ObjectId;
};

export type ConsumedGoogleOAuthRegistrationGrant = {
  providerAccountId: string;
  email: string;
  fullname: string | null;
  avatar: string | null;
};
