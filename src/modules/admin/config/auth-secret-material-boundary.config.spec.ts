import { inspect } from 'node:util';
import { describe, expect, it } from '@jest/globals';
import {
  AUTH_SECRET_BOUNDARY_ENV_KEYS,
  createAuthSecretMaterialBoundary,
} from './auth-secret-material-boundary.config';

const createSource = (values: Record<string, unknown>) => ({
  get: (key: string): unknown => values[key],
});

describe('Auth secret material boundary', () => {
  it.each(AUTH_SECRET_BOUNDARY_ENV_KEYS)(
    'detects raw material configured in %s',
    (configKey) => {
      const rawSecret = 'secret-for-' + configKey;
      const boundary = createAuthSecretMaterialBoundary(
        createSource({ [configKey]: rawSecret }),
      );

      expect(boundary.conflicts([rawSecret])).toBe(true);
      expect(boundary.conflicts(['different-secret'])).toBe(false);
    },
  );

  it('detects decoded Base64 and Base64URL material', () => {
    const base64Bytes = Buffer.alloc(32, 73);
    const base64UrlBytes = Buffer.alloc(32, 74);
    const boundary = createAuthSecretMaterialBoundary(
      createSource({
        JWT_SECRET: base64Bytes.toString('base64'),
        GOOGLE_OAUTH_TRANSACTION_KEY_BASE64:
          base64UrlBytes.toString('base64url'),
      }),
    );

    expect(boundary.conflicts([base64Bytes])).toBe(true);
    expect(boundary.conflicts([base64UrlBytes])).toBe(true);
  });

  it('ignores absent and blank optional boundary values', () => {
    const boundary = createAuthSecretMaterialBoundary(
      createSource({ JWT_SECRET: '   ' }),
    );

    expect(boundary.conflicts(['unrelated'])).toBe(false);
  });

  it('does not expose raw secret through JSON or inspection', () => {
    const rawSecret = 'raw-user-auth-secret';
    const boundary = createAuthSecretMaterialBoundary(
      createSource({ JWT_SECRET: rawSecret }),
    );

    expect(JSON.stringify(boundary)).toBe('{"redacted":true}');
    expect(JSON.stringify(boundary)).not.toContain(rawSecret);
    expect(inspect(boundary)).not.toContain(rawSecret);
  });
});
