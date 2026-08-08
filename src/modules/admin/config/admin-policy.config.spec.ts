import { describe, expect, it } from '@jest/globals';
import { createAdminPolicy, type AdminPolicy } from './admin-policy.config';

const productionConfig: Record<string, unknown> = {
  NODE_ENV: 'production',
  ADMIN_ACCESS_TOKEN_TTL_SECONDS: '900',
  ADMIN_REFRESH_TOKEN_TTL_SECONDS: '604800',
  ADMIN_MAX_FAILED_LOGIN_ATTEMPTS: '5',
  ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: '900',
  ADMIN_LOGIN_LOCK_DURATION_SECONDS: '900',
};

const createPolicy = (values: Record<string, unknown> = {}): AdminPolicy =>
  createAdminPolicy({
    get: (key: string): unknown => values[key],
  });

describe('admin policy configuration', () => {
  it('uses safe developer defaults and locks the approved SRS policy', () => {
    const policy = createPolicy();

    expect(policy.session).toEqual({
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 604_800,
    });
    expect(policy.loginProtection).toEqual({
      maxFailedAttempts: 5,
      failureWindowSeconds: 900,
      lockDurationSeconds: 900,
    });
    expect(policy.activation.grantTtlSeconds).toBe(900);
    expect(policy.reauthentication.grantTtlSeconds).toBe(300);
    expect(policy.mfa).toEqual({
      requiredInProduction: true,
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      acceptedPastSteps: 1,
      acceptedFutureSteps: 1,
      recoveryCodeCount: 10,
      minimumRecoveryCodeEntropyBits: 128,
    });
    expect(policy.reportSla).toEqual({
      p0TriageSeconds: 14_400,
      standardTriageSeconds: 86_400,
      p0DecisionSeconds: 86_400,
      standardDecisionSeconds: 259_200,
      systemIssueTargetReleaseSeconds: 259_200,
    });
    expect(policy.retention).toEqual({
      reportEvidenceGraceDays: 30,
      adminAuditDays: 365,
      safeModerationHistoryDays: 365,
    });
    expect(policy.pagination).toEqual({
      mode: 'page',
      defaultLimit: 20,
      maximumLimit: 100,
      stableTieBreaker: 'publicId',
    });
    expect(policy.revocation.maximumConvergenceSeconds).toBe(5);
  });

  it('accepts an explicitly configured safe production policy', () => {
    expect(() => createPolicy(productionConfig)).not.toThrow();
  });

  it.each([
    'ADMIN_ACCESS_TOKEN_TTL_SECONDS',
    'ADMIN_REFRESH_TOKEN_TTL_SECONDS',
    'ADMIN_MAX_FAILED_LOGIN_ATTEMPTS',
    'ADMIN_LOGIN_FAILURE_WINDOW_SECONDS',
    'ADMIN_LOGIN_LOCK_DURATION_SECONDS',
  ])('fails fast when production omits %s', (key) => {
    const values = { ...productionConfig };
    delete values[key];

    expect(() => createPolicy(values)).toThrow(
      `${key} là bắt buộc trong production`,
    );
  });

  it.each([
    ['ADMIN_ACCESS_TOKEN_TTL_SECONDS', '299'],
    ['ADMIN_ACCESS_TOKEN_TTL_SECONDS', '3601'],
    ['ADMIN_REFRESH_TOKEN_TTL_SECONDS', '3599'],
    ['ADMIN_REFRESH_TOKEN_TTL_SECONDS', '2592001'],
    ['ADMIN_MAX_FAILED_LOGIN_ATTEMPTS', '2'],
    ['ADMIN_MAX_FAILED_LOGIN_ATTEMPTS', '11'],
    ['ADMIN_LOGIN_FAILURE_WINDOW_SECONDS', '59'],
    ['ADMIN_LOGIN_FAILURE_WINDOW_SECONDS', '3601'],
    ['ADMIN_LOGIN_LOCK_DURATION_SECONDS', '59'],
    ['ADMIN_LOGIN_LOCK_DURATION_SECONDS', '86401'],
  ])('rejects an out-of-range %s', (key, value) => {
    expect(() =>
      createPolicy({
        ...productionConfig,
        [key]: value,
      }),
    ).toThrow(`${key} phải là số nguyên trong khoảng`);
  });

  it.each(['1.5', '1e3', '-1', '+900', 'invalid'])(
    'rejects a non-canonical integer: %s',
    (value) => {
      expect(() =>
        createPolicy({
          ...productionConfig,
          ADMIN_ACCESS_TOKEN_TTL_SECONDS: value,
        }),
      ).toThrow(
        'ADMIN_ACCESS_TOKEN_TTL_SECONDS phải là số nguyên trong khoảng',
      );
    },
  );

  it('accepts every configured boundary', () => {
    expect(() =>
      createPolicy({
        NODE_ENV: 'production',
        ADMIN_ACCESS_TOKEN_TTL_SECONDS: '300',
        ADMIN_REFRESH_TOKEN_TTL_SECONDS: '3600',
        ADMIN_MAX_FAILED_LOGIN_ATTEMPTS: '3',
        ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: '60',
        ADMIN_LOGIN_LOCK_DURATION_SECONDS: '60',
      }),
    ).not.toThrow();

    expect(() =>
      createPolicy({
        NODE_ENV: 'production',
        ADMIN_ACCESS_TOKEN_TTL_SECONDS: '3600',
        ADMIN_REFRESH_TOKEN_TTL_SECONDS: '2592000',
        ADMIN_MAX_FAILED_LOGIN_ATTEMPTS: '10',
        ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: '3600',
        ADMIN_LOGIN_LOCK_DURATION_SECONDS: '86400',
      }),
    ).not.toThrow();
  });

  it('rejects an access TTL that is not shorter than refresh TTL', () => {
    expect(() =>
      createPolicy({
        ...productionConfig,
        ADMIN_ACCESS_TOKEN_TTL_SECONDS: '3600',
        ADMIN_REFRESH_TOKEN_TTL_SECONDS: '3600',
      }),
    ).toThrow(
      'ADMIN_ACCESS_TOKEN_TTL_SECONDS phải nhỏ hơn ' +
        'ADMIN_REFRESH_TOKEN_TTL_SECONDS',
    );
  });

  it('rejects an unsupported environment', () => {
    expect(() =>
      createPolicy({
        ...productionConfig,
        NODE_ENV: 'staging',
      }),
    ).toThrow('NODE_ENV phải là developer, test hoặc production');
  });

  it('returns an immutable policy tree', () => {
    const policy = createPolicy();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.session)).toBe(true);
    expect(Object.isFrozen(policy.loginProtection)).toBe(true);
    expect(Object.isFrozen(policy.mfa)).toBe(true);
    expect(Object.isFrozen(policy.reportSla)).toBe(true);
    expect(Object.isFrozen(policy.retention)).toBe(true);
    expect(Object.isFrozen(policy.pagination)).toBe(true);
  });
});
