import { inspect } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import {
  createAuthSecretMaterialBoundary,
  type AuthSecretMaterialBoundary,
} from './auth-secret-material-boundary.config';
import {
  ADMIN_SECRET_ENV_KEYS,
  ADMIN_SECRET_MAX_PREVIOUS_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
  loadAdminSecrets,
} from './admin-secrets.config';

const keyBase64 = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64');

const keyringJson = (
  currentId: string,
  currentByte: number,
  previous: readonly Readonly<{ id: string; byte: number }>[] = [],
): string =>
  JSON.stringify({
    current: { id: currentId, keyBase64: keyBase64(currentByte) },
    previous: previous.map(({ id, byte }) => ({
      id,
      keyBase64: keyBase64(byte),
    })),
  });

const createValues = (): Record<string, unknown> => ({
  [ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING]]: keyringJson(
    'access-v2',
    1,
    [{ id: 'access-v1', byte: 2 }],
  ),
  [ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.REFRESH_TOKEN_SIGNING]]:
    keyringJson('refresh-v1', 3),
  [ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.TOTP_ENCRYPTION]]: keyringJson(
    'totp-v1',
    4,
  ),
  [ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.CONTACT_ENCRYPTION]]: keyringJson(
    'contact-v1',
    5,
  ),
  [ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.CONTACT_LOOKUP_HMAC]]: keyringJson(
    'lookup-v1',
    6,
  ),
});

const createSource = (values: Record<string, unknown>) => ({
  get: (key: string): unknown => values[key],
});

const noConflictBoundary: AuthSecretMaterialBoundary = {
  conflicts: () => false,
  toJSON: () => Object.freeze({ redacted: true }),
};

const createSecrets = (values = createValues()) =>
  createAdminSecrets({
    source: createSource(values),
    forbiddenMaterialBoundary: noConflictBoundary,
  });

const rawKeys = (values: Record<string, unknown>): readonly string[] =>
  Object.values(values).flatMap((rawValue) => {
    if (typeof rawValue !== 'string') {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as {
        current?: { keyBase64?: unknown };
        previous?: Array<{ keyBase64?: unknown }>;
      };

      return [
        parsed.current?.keyBase64,
        ...(parsed.previous ?? []).map((entry) => entry.keyBase64),
      ].filter((value): value is string => typeof value === 'string');
    } catch {
      return [];
    }
  });

const expectNoRawKeyLeak = (error: unknown, keys: readonly string[]): void => {
  const errorText = String(error);

  for (const key of keys) {
    expect(errorText).not.toContain(key);
  }
};

const captureError = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }

  throw new Error('Expected operation to throw');
};

describe('Admin secret configuration', () => {
  it('loads current, candidates and exact key ID', () => {
    const secrets = createSecrets();

    expect(
      secrets
        .candidates(AdminSecretPurpose.ACCESS_TOKEN_SIGNING)
        .map(({ id }) => id),
    ).toEqual(['access-v2', 'access-v1']);
    expect(
      secrets.resolve(AdminSecretPurpose.ACCESS_TOKEN_SIGNING, 'access-v1').id,
    ).toBe('access-v1');
  });

  it('returns defensive copies from all key APIs', () => {
    const secrets = createSecrets();
    const purpose = AdminSecretPurpose.ACCESS_TOKEN_SIGNING;
    const current = secrets.current(purpose);
    const candidates = secrets.candidates(purpose);
    const resolved = secrets.resolve(purpose, 'access-v1');

    current.key.fill(0);
    candidates[0].key.fill(0);
    candidates[1].key.fill(0);
    resolved.key.fill(0);

    expect(secrets.current(purpose).key.equals(Buffer.alloc(32, 1))).toBe(true);
    expect(
      secrets.resolve(purpose, 'access-v1').key.equals(Buffer.alloc(32, 2)),
    ).toBe(true);
  });

  it('exposes only deeply frozen redacted metadata', () => {
    const values = createValues();
    const secrets = createSecrets(values);
    const metadata = secrets.describe();
    const serialized = JSON.stringify(secrets);
    const inspected = inspect(secrets);

    expect(Object.isFrozen(secrets)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata[0])).toBe(true);
    expect(Object.isFrozen(metadata[0].previousKeyIds)).toBe(true);

    for (const key of rawKeys(values)) {
      expect(serialized).not.toContain(key);
      expect(inspected).not.toContain(key);
    }
  });

  it.each(Object.values(ADMIN_SECRET_ENV_KEYS))(
    'fails fast when %s is missing',
    (configKey) => {
      const values = createValues();
      delete values[configKey];

      expect(() => createSecrets(values)).toThrow(configKey + ' là bắt buộc');
    },
  );

  it('rejects invalid JSON without leaking an embedded raw key', () => {
    const values = createValues();
    const configKey =
      ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING];
    const embeddedKey = keyBase64(19);
    values[configKey] =
      '{"current":{"id":"v1","keyBase64":"' + embeddedKey + '"}';

    const error = captureError(() => createSecrets(values));

    expect(String(error)).toContain('phải là JSON hợp lệ');
    expectNoRawKeyLeak(error, [embeddedKey]);
  });

  it.each([
    ['missing padding', keyBase64(20).slice(0, -1)],
    ['Base64URL alphabet', Buffer.alloc(32, 255).toString('base64url')],
    ['leading whitespace', ' ' + keyBase64(20)],
    ['trailing newline', keyBase64(20) + '\n'],
    ['non-canonical pad bits', keyBase64(0).slice(0, -2) + 'B='],
  ])('rejects non-canonical Base64: %s', (_label, invalidKey) => {
    const values = createValues();
    const configKey =
      ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING];
    values[configKey] = JSON.stringify({
      current: { id: 'access-v1', keyBase64: invalidKey },
      previous: [],
    });

    const error = captureError(() => createSecrets(values));

    expect(String(error)).toContain(configKey);
    expectNoRawKeyLeak(error, [invalidKey]);
  });

  it('accepts four previous keys and rejects five', () => {
    const configKey =
      ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING];
    const fourValues = createValues();
    fourValues[configKey] = keyringJson(
      'access-v5',
      20,
      Array.from({ length: ADMIN_SECRET_MAX_PREVIOUS_KEYS }, (_, index) => ({
        id: 'access-v' + String(index + 1),
        byte: 21 + index,
      })),
    );

    expect(() => createSecrets(fourValues)).not.toThrow();

    const fiveValues = createValues();
    fiveValues[configKey] = keyringJson(
      'access-v6',
      20,
      Array.from(
        { length: ADMIN_SECRET_MAX_PREVIOUS_KEYS + 1 },
        (_, index) => ({
          id: 'access-v' + String(index + 1),
          byte: 21 + index,
        }),
      ),
    );

    expect(() => createSecrets(fiveValues)).toThrow(
      'cấu trúc keyring không hợp lệ',
    );
  });

  it('rejects duplicate IDs and material without leaking keys', () => {
    const configKey =
      ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING];

    for (const rawValue of [
      keyringJson('same-id', 30, [{ id: 'same-id', byte: 31 }]),
      keyringJson('v2', 30, [{ id: 'v1', byte: 30 }]),
    ]) {
      const values = createValues();
      values[configKey] = rawValue;

      const error = captureError(() => createSecrets(values));

      expect(error).toBeInstanceOf(Error);
      expectNoRawKeyLeak(error, rawKeys(values));
    }
  });

  it('rejects reuse across Admin purposes', () => {
    const values = createValues();
    values[ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.REFRESH_TOKEN_SIGNING]] =
      keyringJson('refresh-v1', 1);

    const error = captureError(() => createSecrets(values));

    expect(String(error)).toContain('không được dùng chung giữa các purpose');
    expectNoRawKeyLeak(error, rawKeys(values));
  });

  it.each([
    ['JWT_SECRET', AdminSecretPurpose.ACCESS_TOKEN_SIGNING],
    ['JWT_REFRESH_SECRET', AdminSecretPurpose.REFRESH_TOKEN_SIGNING],
    ['GOOGLE_OAUTH_TRANSACTION_KEY_BASE64', AdminSecretPurpose.TOTP_ENCRYPTION],
    [
      'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64',
      AdminSecretPurpose.CONTACT_ENCRYPTION,
    ],
    ['GOOGLE_OAUTH_CLIENT_SECRET', AdminSecretPurpose.CONTACT_LOOKUP_HMAC],
  ] as const)(
    'rejects Admin material reused from %s',
    (boundaryKey, purpose) => {
      const values = createValues();
      const material = Buffer.alloc(32, 90);
      const encoded = material.toString('base64');
      values[ADMIN_SECRET_ENV_KEYS[purpose]] = JSON.stringify({
        current: { id: 'conflicting-v1', keyBase64: encoded },
        previous: [],
      });
      const forbiddenMaterialBoundary = createAuthSecretMaterialBoundary(
        createSource({ [boundaryKey]: encoded }),
      );

      const error = captureError(() =>
        createAdminSecrets({
          source: createSource(values),
          forbiddenMaterialBoundary,
        }),
      );

      expect(String(error)).toContain('xung đột với secret boundary khác');
      expectNoRawKeyLeak(error, [encoded]);
    },
  );

  it('fails closed for unknown purpose and key ID', () => {
    const secrets = createSecrets();
    const unknownKeyId = 'attacker-controlled-key-id';

    const purposeError = captureError(() => secrets.current('USER_JWT'));

    expect(String(purposeError)).toContain('Admin secret purpose không hợp lệ');
    expect(String(purposeError)).not.toContain('USER_JWT');

    const error = captureError(() =>
      secrets.resolve(AdminSecretPurpose.ACCESS_TOKEN_SIGNING, unknownKeyId),
    );

    expect(String(error)).toContain('key không khả dụng');
    expect(String(error)).not.toContain(unknownKeyId);
  });

  it('loads through provider factory and fails fast', () => {
    const values = createValues();
    const configService = {
      get: (key: string): unknown => values[key],
    } as unknown as ConfigService;

    expect(
      loadAdminSecrets(configService, noConflictBoundary).current(
        AdminSecretPurpose.ACCESS_TOKEN_SIGNING,
      ).id,
    ).toBe('access-v2');

    values[ADMIN_SECRET_ENV_KEYS[AdminSecretPurpose.ACCESS_TOKEN_SIGNING]] =
      '{';

    expect(() => loadAdminSecrets(configService, noConflictBoundary)).toThrow(
      'phải là JSON hợp lệ',
    );
  });
});
