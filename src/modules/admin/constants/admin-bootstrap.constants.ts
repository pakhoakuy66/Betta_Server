export const ADMIN_BOOTSTRAP_SINGLETON_KEY = 'initial_super_admin' as const;
export const ADMIN_BOOTSTRAP_GRANT_BYTES = 32 as const;
export const ADMIN_BOOTSTRAP_GRANT_LENGTH = 43 as const;
export const ADMIN_BOOTSTRAP_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ADMIN_BOOTSTRAP_GRANT_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._:/?@%+=#~-]{7,511}$/;
export const ADMIN_BOOTSTRAP_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,63}$/;
export const ADMIN_BOOTSTRAP_SECRET_COMMAND_TIMEOUT_MS = 30_000 as const;
export const ADMIN_BOOTSTRAP_SECRET_COMMAND_MAX_OUTPUT_BYTES = 4_096 as const;

export const ADMIN_BOOTSTRAP_CONFIRMATION_ENV =
  'ADMIN_BOOTSTRAP_EXECUTION_CONFIRMATION' as const;
export const ADMIN_BOOTSTRAP_CONFIRMATION_VALUE = 'YES' as const;
export const ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV =
  'ADMIN_BOOTSTRAP_SECRET_WRITER_EXECUTABLE' as const;
export const ADMIN_BOOTSTRAP_SECRET_ARGS_ENV =
  'ADMIN_BOOTSTRAP_SECRET_WRITER_ARGS_JSON' as const;

export enum AdminActivationGrantPurpose {
  BOOTSTRAP_SUPER_ADMIN = 'bootstrap_super_admin',
  ADMIN_ACCOUNT_ACTIVATION = 'admin_account_activation',
}

export enum AdminBootstrapEnvironment {
  DEVELOPER = 'developer',
  TEST = 'test',
  PRODUCTION = 'production',
}

export enum AdminBootstrapMode {
  DRY_RUN = 'dry-run',
  EXECUTE = 'execute',
}

export enum AdminBootstrapOutcome {
  WOULD_CREATE = 'would-create',
  WOULD_REISSUE = 'would-reissue',
  CREATED = 'created',
  REISSUED = 'reissued',
  SKIPPED = 'skipped',
}
