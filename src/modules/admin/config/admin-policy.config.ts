import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const ADMIN_POLICY = Symbol('ADMIN_POLICY');

type AdminEnvironment = 'developer' | 'test' | 'production';

type ConfigReader = {
  get(key: string): unknown;
};

export type AdminPolicy = Readonly<{
  environment: AdminEnvironment;
  session: Readonly<{
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }>;
  loginProtection: Readonly<{
    maxFailedAttempts: number;
    failureWindowSeconds: number;
    lockDurationSeconds: number;
  }>;
  activation: Readonly<{
    grantTtlSeconds: 900;
  }>;
  mfa: Readonly<{
    requiredInProduction: true;
    algorithm: 'SHA1';
    digits: 6;
    periodSeconds: 30;
    acceptedPastSteps: 1;
    acceptedFutureSteps: 1;
    recoveryCodeCount: 10;
    minimumRecoveryCodeEntropyBits: 128;
  }>;
  reauthentication: Readonly<{
    grantTtlSeconds: 300;
  }>;
  reportSla: Readonly<{
    p0TriageSeconds: 14_400;
    standardTriageSeconds: 86_400;
    p0DecisionSeconds: 86_400;
    standardDecisionSeconds: 259_200;
    systemIssueTargetReleaseSeconds: 259_200;
  }>;
  retention: Readonly<{
    reportEvidenceGraceDays: 30;
    adminAuditDays: 365;
    safeModerationHistoryDays: 365;
  }>;
  pagination: Readonly<{
    mode: 'page';
    defaultLimit: 20;
    maximumLimit: 100;
    stableTieBreaker: 'publicId';
  }>;
  revocation: Readonly<{
    maximumConvergenceSeconds: 5;
  }>;
}>;

type IntegerPolicy = Readonly<{
  key: string;
  fallback: number;
  minimum: number;
  maximum: number;
}>;

const ENVIRONMENTS = new Set<AdminEnvironment>([
  'developer',
  'test',
  'production',
]);

const INTEGER_POLICIES = {
  accessTokenTtlSeconds: {
    key: 'ADMIN_ACCESS_TOKEN_TTL_SECONDS',
    fallback: 900,
    minimum: 300,
    maximum: 3_600,
  },
  refreshTokenTtlSeconds: {
    key: 'ADMIN_REFRESH_TOKEN_TTL_SECONDS',
    fallback: 604_800,
    minimum: 3_600,
    maximum: 2_592_000,
  },
  maxFailedAttempts: {
    key: 'ADMIN_MAX_FAILED_LOGIN_ATTEMPTS',
    fallback: 5,
    minimum: 3,
    maximum: 10,
  },
  failureWindowSeconds: {
    key: 'ADMIN_LOGIN_FAILURE_WINDOW_SECONDS',
    fallback: 900,
    minimum: 60,
    maximum: 3_600,
  },
  lockDurationSeconds: {
    key: 'ADMIN_LOGIN_LOCK_DURATION_SECONDS',
    fallback: 900,
    minimum: 60,
    maximum: 86_400,
  },
} as const satisfies Record<string, IntegerPolicy>;

const isMissing = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim().length === 0);

const readEnvironment = (source: ConfigReader): AdminEnvironment => {
  const value = source.get('NODE_ENV');
  const normalized = isMissing(value) ? 'developer' : String(value).trim();

  if (!ENVIRONMENTS.has(normalized as AdminEnvironment)) {
    throw new Error('NODE_ENV phải là developer, test hoặc production');
  }

  return normalized as AdminEnvironment;
};

const readInteger = (
  source: ConfigReader,
  environment: AdminEnvironment,
  policy: IntegerPolicy,
): number => {
  const rawValue = source.get(policy.key);

  if (isMissing(rawValue)) {
    if (environment === 'production') {
      throw new Error(`${policy.key} là bắt buộc trong production`);
    }

    return policy.fallback;
  }

  const normalized = typeof rawValue === 'string' ? rawValue.trim() : rawValue;

  if (
    (typeof normalized === 'string' && !/^(0|[1-9]\d*)$/.test(normalized)) ||
    (typeof normalized !== 'string' && typeof normalized !== 'number')
  ) {
    throw new Error(
      `${policy.key} phải là số nguyên trong khoảng ` +
        `${policy.minimum}..${policy.maximum}`,
    );
  }

  const value = Number(normalized);

  if (
    !Number.isSafeInteger(value) ||
    value < policy.minimum ||
    value > policy.maximum
  ) {
    throw new Error(
      `${policy.key} phải là số nguyên trong khoảng ` +
        `${policy.minimum}..${policy.maximum}`,
    );
  }

  return value;
};

const freeze = <T extends object>(value: T): Readonly<T> =>
  Object.freeze(value);

export const createAdminPolicy = (source: ConfigReader): AdminPolicy => {
  const environment = readEnvironment(source);
  const session = freeze({
    accessTokenTtlSeconds: readInteger(
      source,
      environment,
      INTEGER_POLICIES.accessTokenTtlSeconds,
    ),
    refreshTokenTtlSeconds: readInteger(
      source,
      environment,
      INTEGER_POLICIES.refreshTokenTtlSeconds,
    ),
  });

  if (session.accessTokenTtlSeconds >= session.refreshTokenTtlSeconds) {
    throw new Error(
      'ADMIN_ACCESS_TOKEN_TTL_SECONDS phải nhỏ hơn ' +
        'ADMIN_REFRESH_TOKEN_TTL_SECONDS',
    );
  }

  return freeze({
    environment,
    session,
    loginProtection: freeze({
      maxFailedAttempts: readInteger(
        source,
        environment,
        INTEGER_POLICIES.maxFailedAttempts,
      ),
      failureWindowSeconds: readInteger(
        source,
        environment,
        INTEGER_POLICIES.failureWindowSeconds,
      ),
      lockDurationSeconds: readInteger(
        source,
        environment,
        INTEGER_POLICIES.lockDurationSeconds,
      ),
    }),
    activation: freeze({ grantTtlSeconds: 900 as const }),
    mfa: freeze({
      requiredInProduction: true as const,
      algorithm: 'SHA1' as const,
      digits: 6 as const,
      periodSeconds: 30 as const,
      acceptedPastSteps: 1 as const,
      acceptedFutureSteps: 1 as const,
      recoveryCodeCount: 10 as const,
      minimumRecoveryCodeEntropyBits: 128 as const,
    }),
    reauthentication: freeze({ grantTtlSeconds: 300 as const }),
    reportSla: freeze({
      p0TriageSeconds: 14_400 as const,
      standardTriageSeconds: 86_400 as const,
      p0DecisionSeconds: 86_400 as const,
      standardDecisionSeconds: 259_200 as const,
      systemIssueTargetReleaseSeconds: 259_200 as const,
    }),
    retention: freeze({
      reportEvidenceGraceDays: 30 as const,
      adminAuditDays: 365 as const,
      safeModerationHistoryDays: 365 as const,
    }),
    pagination: freeze({
      mode: 'page' as const,
      defaultLimit: 20 as const,
      maximumLimit: 100 as const,
      stableTieBreaker: 'publicId' as const,
    }),
    revocation: freeze({ maximumConvergenceSeconds: 5 as const }),
  });
};

export const ADMIN_POLICY_PROVIDER: Provider = {
  provide: ADMIN_POLICY,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AdminPolicy =>
    createAdminPolicy({
      get: (key: string): unknown => configService.get(key),
    }),
};
