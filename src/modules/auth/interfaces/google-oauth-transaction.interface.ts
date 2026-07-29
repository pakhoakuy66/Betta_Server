export type GoogleOAuthAuthorizationStart = {
  authorizationUrl: string;

  // Chỉ dùng để controller ghi HttpOnly cookie.
  // Không được trả trong JSON response.
  browserState: string;

  expiresAt: Date;
};

export type ConsumedGoogleOAuthTransaction = {
  codeVerifier: string;
  expectedNonceHash: string;
};

export type GoogleOAuthProviderConfiguration = {
  clientId: string;
  callbackUrl: string;
};
