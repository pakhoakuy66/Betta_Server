import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  AUTH_SECRET_MATERIAL_BOUNDARY,
  type AuthSecretMaterialBoundary,
} from './auth-secret-material-boundary.config';

export const ADMIN_SECRETS = Symbol('ADMIN_SECRETS');

export const AdminSecretPurpose = Object.freeze({
  ACCESS_TOKEN_SIGNING: 'ACCESS_TOKEN_SIGNING',
  REFRESH_TOKEN_SIGNING: 'REFRESH_TOKEN_SIGNING',
  TOTP_ENCRYPTION: 'TOTP_ENCRYPTION',
  CONTACT_ENCRYPTION: 'CONTACT_ENCRYPTION',
  CONTACT_LOOKUP_HMAC: 'CONTACT_LOOKUP_HMAC',
} as const);

export type AdminSecretPurpose =
  (typeof AdminSecretPurpose)[keyof typeof AdminSecretPurpose];

export const ADMIN_SECRET_ENV_KEYS = Object.freeze({
  [AdminSecretPurpose.ACCESS_TOKEN_SIGNING]: 'ADMIN_ACCESS_TOKEN_KEYRING_JSON',
  [AdminSecretPurpose.REFRESH_TOKEN_SIGNING]:
    'ADMIN_REFRESH_TOKEN_KEYRING_JSON',
  [AdminSecretPurpose.TOTP_ENCRYPTION]: 'ADMIN_TOTP_ENCRYPTION_KEYRING_JSON',
  [AdminSecretPurpose.CONTACT_ENCRYPTION]:
    'ADMIN_CONTACT_ENCRYPTION_KEYRING_JSON',
  [AdminSecretPurpose.CONTACT_LOOKUP_HMAC]:
    'ADMIN_CONTACT_LOOKUP_HMAC_KEYRING_JSON',
} as const satisfies Record<AdminSecretPurpose, string>);

export type AdminSecretKey = Readonly<{
  id: string;
  key: Buffer;
}>;

export type AdminSecretKeyringMetadata = Readonly<{
  purpose: AdminSecretPurpose;
  currentKeyId: string;
  previousKeyIds: readonly string[];
}>;

export interface AdminSecrets {
  current(purpose: unknown): AdminSecretKey;
  resolve(purpose: unknown, keyId: unknown): AdminSecretKey;
  candidates(purpose: unknown): readonly AdminSecretKey[];
  describe(): readonly AdminSecretKeyringMetadata[];
  toJSON(): Readonly<{
    redacted: true;
    keyrings: readonly AdminSecretKeyringMetadata[];
  }>;
}

type ConfigReader = {
  get(key: string): unknown;
};

type InternalSecretKey = Readonly<{
  id: string;
  key: Buffer;
  keyBase64: string;
  fingerprint: string;
}>;

type InternalSecretKeyring = Readonly<{
  current: InternalSecretKey;
  previous: readonly InternalSecretKey[];
  byId: ReadonlyMap<string, InternalSecretKey>;
}>;

type UnknownRecord = Record<string, unknown>;

const PURPOSES = Object.freeze(
  Object.values(AdminSecretPurpose),
) as readonly AdminSecretPurpose[];
const PURPOSE_SET = new Set<AdminSecretPurpose>(PURPOSES);
const KEY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,31})$/;
const CANONICAL_32_BYTE_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
export const ADMIN_SECRET_MAX_PREVIOUS_KEYS = 4;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: UnknownRecord,
  allowedKeys: readonly string[],
): boolean => {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const fingerprint = (key: Buffer): string =>
  createHash('sha256').update(key).digest('hex');

const copyPublicKey = (entry: InternalSecretKey): AdminSecretKey =>
  Object.freeze({ id: entry.id, key: Buffer.from(entry.key) });

const parseSecretKey = (
  value: unknown,
  configKey: string,
  position: string,
): InternalSecretKey => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'keyBase64']) ||
    typeof value.id !== 'string' ||
    !KEY_ID_PATTERN.test(value.id) ||
    typeof value.keyBase64 !== 'string' ||
    !CANONICAL_32_BYTE_BASE64_PATTERN.test(value.keyBase64)
  ) {
    throw new Error(configKey + '.' + position + ' không hợp lệ');
  }

  const key = Buffer.from(value.keyBase64, 'base64');

  if (key.length !== 32 || key.toString('base64') !== value.keyBase64) {
    throw new Error(
      configKey + '.' + position + ' phải chứa key Base64 32 byte',
    );
  }

  return Object.freeze({
    id: value.id,
    key,
    keyBase64: value.keyBase64,
    fingerprint: fingerprint(key),
  });
};

const parseKeyring = (
  rawValue: unknown,
  configKey: string,
): InternalSecretKeyring => {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    throw new Error(configKey + ' là bắt buộc');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(configKey + ' phải là JSON hợp lệ');
  }

  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ['current', 'previous']) ||
    !Array.isArray(parsed.previous) ||
    parsed.previous.length > ADMIN_SECRET_MAX_PREVIOUS_KEYS
  ) {
    throw new Error(configKey + ' có cấu trúc keyring không hợp lệ');
  }

  const current = parseSecretKey(parsed.current, configKey, 'current');
  const previous = Object.freeze(
    parsed.previous.map((entry, index) =>
      parseSecretKey(entry, configKey, 'previous[' + String(index) + ']'),
    ),
  );
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const byId = new Map<string, InternalSecretKey>();

  for (const entry of [current, ...previous]) {
    if (ids.has(entry.id)) {
      throw new Error(configKey + ' không được chứa key ID trùng lặp');
    }

    if (fingerprints.has(entry.fingerprint)) {
      throw new Error(configKey + ' không được chứa key material trùng lặp');
    }

    ids.add(entry.id);
    fingerprints.add(entry.fingerprint);
    byId.set(entry.id, entry);
  }

  return Object.freeze({ current, previous, byId });
};

const isAdminSecretPurpose = (value: unknown): value is AdminSecretPurpose =>
  typeof value === 'string' && PURPOSE_SET.has(value as AdminSecretPurpose);

class DefaultAdminSecrets implements AdminSecrets {
  readonly #keyrings: ReadonlyMap<AdminSecretPurpose, InternalSecretKeyring>;

  constructor(
    keyrings: ReadonlyMap<AdminSecretPurpose, InternalSecretKeyring>,
  ) {
    this.#keyrings = keyrings;
    Object.freeze(this);
  }

  current(purpose: unknown): AdminSecretKey {
    return copyPublicKey(this.getKeyring(purpose).current);
  }

  resolve(purpose: unknown, keyId: unknown): AdminSecretKey {
    if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
      throw new Error('Admin secret key không khả dụng');
    }

    const entry = this.getKeyring(purpose).byId.get(keyId);

    if (!entry) {
      throw new Error('Admin secret key không khả dụng');
    }

    return copyPublicKey(entry);
  }

  candidates(purpose: unknown): readonly AdminSecretKey[] {
    const keyring = this.getKeyring(purpose);

    return Object.freeze(
      [keyring.current, ...keyring.previous].map(copyPublicKey),
    );
  }

  describe(): readonly AdminSecretKeyringMetadata[] {
    return Object.freeze(
      PURPOSES.map((purpose) => {
        const keyring = this.getKeyring(purpose);

        return Object.freeze({
          purpose,
          currentKeyId: keyring.current.id,
          previousKeyIds: Object.freeze(
            keyring.previous.map((entry) => entry.id),
          ),
        });
      }),
    );
  }

  toJSON(): Readonly<{
    redacted: true;
    keyrings: readonly AdminSecretKeyringMetadata[];
  }> {
    return Object.freeze({ redacted: true, keyrings: this.describe() });
  }

  private getKeyring(purpose: unknown): InternalSecretKeyring {
    if (!isAdminSecretPurpose(purpose)) {
      throw new Error('Admin secret purpose không hợp lệ');
    }

    const keyring = this.#keyrings.get(purpose);

    if (!keyring) {
      throw new Error('Admin secret keyring chưa được cấu hình');
    }

    return keyring;
  }
}

export const createAdminSecrets = ({
  source,
  forbiddenMaterialBoundary,
}: Readonly<{
  source: ConfigReader;
  forbiddenMaterialBoundary: AuthSecretMaterialBoundary;
}>): AdminSecrets => {
  const keyrings = new Map<AdminSecretPurpose, InternalSecretKeyring>();
  const materialOwners = new Map<string, AdminSecretPurpose>();

  for (const purpose of PURPOSES) {
    const configKey = ADMIN_SECRET_ENV_KEYS[purpose];
    const keyring = parseKeyring(source.get(configKey), configKey);

    for (const entry of [keyring.current, ...keyring.previous]) {
      if (forbiddenMaterialBoundary.conflicts([entry.key, entry.keyBase64])) {
        throw new Error(
          'Admin secret material xung đột với secret boundary khác',
        );
      }

      if (materialOwners.has(entry.fingerprint)) {
        throw new Error(
          'Admin secret key material không được dùng chung giữa các purpose',
        );
      }

      materialOwners.set(entry.fingerprint, purpose);
    }

    keyrings.set(purpose, keyring);
  }

  return new DefaultAdminSecrets(keyrings);
};

export const loadAdminSecrets = (
  configService: ConfigService,
  forbiddenMaterialBoundary: AuthSecretMaterialBoundary,
): AdminSecrets =>
  createAdminSecrets({
    source: {
      get: (key: string): unknown => configService.get(key),
    },
    forbiddenMaterialBoundary,
  });

export const ADMIN_SECRETS_PROVIDER: Provider = {
  provide: ADMIN_SECRETS,
  inject: [ConfigService, AUTH_SECRET_MATERIAL_BOUNDARY],
  useFactory: loadAdminSecrets,
};
