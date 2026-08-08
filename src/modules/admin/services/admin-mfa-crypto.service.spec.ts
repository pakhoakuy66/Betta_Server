import { describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  AdminSecretPurpose,
  type AdminSecretKey,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';

const current: AdminSecretKey = Object.freeze({
  id: 'totp-v2',
  key: randomBytes(32),
});
const previous: AdminSecretKey = Object.freeze({
  id: 'totp-v1',
  key: randomBytes(32),
});
const secrets: AdminSecrets = {
  current: () => current,
  resolve: (purpose, keyId) => {
    expect(purpose).toBe(AdminSecretPurpose.TOTP_ENCRYPTION);
    if (keyId === current.id) return current;
    if (keyId === previous.id) return previous;
    throw new Error('unavailable');
  },
  candidates: () => [current, previous],
  describe: () => [],
  toJSON: () => ({ redacted: true, keyrings: [] }),
};

describe('AdminMfaCryptoService', () => {
  const service = new AdminMfaCryptoService(secrets);
  const publicId = 'adm_23456789ABCD';

  it('encrypts with AES-GCM and binds ciphertext to the Admin public ID', () => {
    const secret = service.generateTotpSecret();
    const envelope = service.encryptTotpSecret(secret, publicId);

    expect(envelope).not.toContain(secret.toString('base64'));
    expect(service.decryptTotpSecret(envelope, publicId)).toEqual(secret);
    expect(() =>
      service.decryptTotpSecret(envelope, 'adm_23456789ABCE'),
    ).toThrow('Admin TOTP secret không khả dụng');
  });

  it('rejects a tampered authentication tag without leaking key material', () => {
    const envelope = service.encryptTotpSecret(
      service.generateTotpSecret(),
      publicId,
    );
    const parts = envelope.split('.');
    const tag = parts[4];
    parts[4] = `${tag.startsWith('A') ? 'B' : 'A'}${tag.slice(1)}`;
    const tampered = parts.join('.');

    expect(() => service.decryptTotpSecret(tampered, publicId)).toThrow(
      'Admin TOTP secret không khả dụng',
    );
  });

  it('issues ten unique 128-bit recovery codes and stores deterministic hashes', () => {
    const codes = service.generateRecoveryCodes(10);
    const hashes = codes.map((code) => service.hashRecoveryCode(code));

    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Za-z0-9_-]{22}$/.test(code))).toBe(true);
    expect(new Set(hashes).size).toBe(10);
    expect(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it('decrypts ciphertext produced before TOTP key rotation', () => {
    const beforeRotation: AdminSecrets = {
      ...secrets,
      current: () => previous,
      resolve: (_purpose, keyId) => {
        if (keyId === previous.id) return previous;
        throw new Error('unavailable');
      },
      candidates: () => [previous],
    };
    const oldService = new AdminMfaCryptoService(beforeRotation);
    const secret = oldService.generateTotpSecret();
    const envelope = oldService.encryptTotpSecret(secret, publicId);

    expect(service.decryptTotpSecret(envelope, publicId)).toEqual(secret);
  });
});
