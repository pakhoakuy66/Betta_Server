export type JwtRequestUser = {
  _id: string;
  id?: string;
  email?: string;
  username?: string;
};

export type AuthenticatedRequest = {
  user: JwtRequestUser;
};

export type OptionalAuthenticatedRequest = {
  user?: JwtRequestUser;
};
