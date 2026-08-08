import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

export const AUTH_SECRET_MATERIAL_BOUNDARY = Symbol(
  'AUTH_SECRET_MATERIAL_BOUNDARY',
);

export const AUTH_SECRET_BOUNDARY_ENV_KEYS = Object.freeze([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'AUTH_RATE_LIMIT_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_TRANSACTION_KEY_BASE64',
  'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64',
] as const);

export type SecretMaterialInput = string | Uint8Array;

export interface AuthSecretMaterialBoundary {
  conflicts(materials: readonly SecretMaterialInput[]): boolean;
  toJSON(): Readonly<{ redacted: true }>;
}

type ConfigReader = {
  get(key: string): unknown;
};

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const fingerprint = (value: SecretMaterialInput): string =>
  createHash('sha256').update(value).digest('hex');

const decodeCanonicalBase64 = (value: string): Buffer | null => {
  if (!CANONICAL_BASE64_PATTERN.test(value) || value.length % 4 !== 0) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
};

const decodeCanonicalBase64Url = (value: string): Buffer | null => {
  if (!CANONICAL_BASE64URL_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
};

const collectFingerprints = (rawValue: unknown, target: Set<string>): void => {
  if (typeof rawValue !== 'string') {
    return;
  }

  const value = rawValue.trim();

  if (value.length === 0) {
    return;
  }

  target.add(fingerprint(value));

  const decodedBase64 = decodeCanonicalBase64(value);
  if (decodedBase64) {
    target.add(fingerprint(decodedBase64));
  }

  const decodedBase64Url = decodeCanonicalBase64Url(value);
  if (decodedBase64Url) {
    target.add(fingerprint(decodedBase64Url));
  }
};

class DefaultAuthSecretMaterialBoundary implements AuthSecretMaterialBoundary {
  readonly #fingerprints: ReadonlySet<string>;

  constructor(source: ConfigReader) {
    const fingerprints = new Set<string>();

    for (const configKey of AUTH_SECRET_BOUNDARY_ENV_KEYS) {
      collectFingerprints(source.get(configKey), fingerprints);
    }

    this.#fingerprints = fingerprints;
    Object.freeze(this);
  }

  conflicts(materials: readonly SecretMaterialInput[]): boolean {
    return materials.some((material) =>
      this.#fingerprints.has(fingerprint(material)),
    );
  }

  toJSON(): Readonly<{ redacted: true }> {
    return Object.freeze({ redacted: true });
  }
}

export const createAuthSecretMaterialBoundary = (
  source: ConfigReader,
): AuthSecretMaterialBoundary => new DefaultAuthSecretMaterialBoundary(source);

export const AUTH_SECRET_MATERIAL_BOUNDARY_PROVIDER: Provider = {
  provide: AUTH_SECRET_MATERIAL_BOUNDARY,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AuthSecretMaterialBoundary =>
    createAuthSecretMaterialBoundary({
      get: (key: string): unknown => configService.get(key),
    }),
};
