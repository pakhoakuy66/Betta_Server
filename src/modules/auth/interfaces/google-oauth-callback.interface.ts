import type { SessionRequestMetadata } from './auth-session.interface';
import type { IssuedGoogleOAuthContinuationGrant } from './google-oauth-continuation-grant.interface';
import type { IssuedGoogleOAuthSessionHandoff } from './google-oauth-session-handoff.interface';
import { GoogleOAuthAccountResolutionStatus } from './google-oauth-account-resolution.interface';

export const GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT = Symbol(
  'GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT',
);

export const GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF = Symbol(
  'GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF',
);

export type GoogleOAuthCallbackInput = {
  authorizationCode: string;
  callbackState: string;
  browserState: string;
  metadata: SessionRequestMetadata;
};

export type GoogleOAuthCallbackSignInResult = {
  status: GoogleOAuthAccountResolutionStatus.SIGN_IN;
  [GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF]: IssuedGoogleOAuthSessionHandoff;
};

export type GoogleOAuthCallbackLinkResult = {
  status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED;
  email: string;
  [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: IssuedGoogleOAuthContinuationGrant;
};

export type GoogleOAuthCallbackRegistrationResult = {
  status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED;
  profile: {
    email: string;
    fullname: string | null;
    avatar: string | null;
  };
  [GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT]: IssuedGoogleOAuthContinuationGrant;
};

export type GoogleOAuthCallbackResult =
  | GoogleOAuthCallbackSignInResult
  | GoogleOAuthCallbackLinkResult
  | GoogleOAuthCallbackRegistrationResult;
