export const ADMIN_ACCOUNT_QUERY_DEFAULT_PAGE = 1 as const;
export const ADMIN_ACCOUNT_QUERY_DEFAULT_LIMIT = 20 as const;
export const ADMIN_ACCOUNT_QUERY_MAX_LIMIT = 100 as const;
export const ADMIN_ACCOUNT_QUERY_MAX_PAGE = 100_000 as const;
export const ADMIN_ACCOUNT_QUERY_SEARCH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9@._+-]{1,253}$/;
