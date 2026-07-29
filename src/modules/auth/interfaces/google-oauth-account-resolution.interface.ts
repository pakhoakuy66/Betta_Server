import type { Types } from 'mongoose';

export enum GoogleOAuthAccountResolutionStatus {
  SIGN_IN = 'SIGN_IN',
  ACCOUNT_LINK_REQUIRED = 'ACCOUNT_LINK_REQUIRED',
  REGISTRATION_REQUIRED = 'REGISTRATION_REQUIRED',
}

export const GOOGLE_OAUTH_INTERNAL_USER_ID = Symbol(
  'GOOGLE_OAUTH_INTERNAL_USER_ID',
);

export type GoogleOAuthSignInResolution = {
  status: GoogleOAuthAccountResolutionStatus.SIGN_IN;
  [GOOGLE_OAUTH_INTERNAL_USER_ID]: Types.ObjectId;
};

export type GoogleOAuthAccountLinkResolution = {
  status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED;

  email: string;

  [GOOGLE_OAUTH_INTERNAL_USER_ID]: Types.ObjectId;
};

export type GoogleOAuthRegistrationResolution = {
  status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED;
  profile: {
    email: string;
    fullname: string | null;
    avatar: string | null;
  };
};

export type GoogleOAuthInternalAccountResolution =
  | GoogleOAuthSignInResolution
  | GoogleOAuthAccountLinkResolution
  | GoogleOAuthRegistrationResolution;
