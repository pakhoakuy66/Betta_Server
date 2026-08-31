import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AccessSupportSecretsConfig } from '../config/access-support-secrets.config';
import { AccessSupportCryptoService } from './access-support-crypto.service';

const keyring = (byte: number, id: string) =>
  JSON.stringify({
    current: { id, keyBase64: Buffer.alloc(32, byte).toString('base64') },
  });

const rotatedKeyring = () =>
  JSON.stringify({
    current: {
      id: 'enc-v2',
      keyBase64: Buffer.alloc(32, 5).toString('base64'),
    },
    previous: [
      {
        id: 'enc-v1',
        keyBase64: Buffer.alloc(32, 3).toString('base64'),
      },
    ],
  });

describe('AccessSupportCryptoService', () => {
  const service = new AccessSupportCryptoService(
    new AccessSupportSecretsConfig(
      new ConfigService({
        ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: keyring(3, 'enc-v1'),
        ACCESS_SUPPORT_HMAC_KEYRING_JSON: keyring(4, 'hmac-v1'),
      }),
    ),
  );

  it('encrypts without retaining plaintext and randomizes envelopes', () => {
    const first = service.encrypt('person@example.com', 'srep_test', 'contact');
    const second = service.encrypt(
      'person@example.com',
      'srep_test',
      'contact',
    );
    expect(first).toMatch(/^asenc\.v1\.enc-v1\./);
    expect(first).not.toContain('person@example.com');
    expect(first).not.toBe(second);
    expect(service.decrypt(first, 'srep_test', 'contact')).toBe(
      'person@example.com',
    );
  });

  it('decrypts an envelope created by a previous rotation key', () => {
    const ciphertext = service.encrypt(
      'previous@example.com',
      'srep_rotation',
      'contactEmail',
    );
    const rotated = new AccessSupportCryptoService(
      new AccessSupportSecretsConfig(
        new ConfigService({
          ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: rotatedKeyring(),
          ACCESS_SUPPORT_HMAC_KEYRING_JSON: keyring(4, 'hmac-v1'),
        }),
      ),
    );

    expect(rotated.decrypt(ciphertext, 'srep_rotation', 'contactEmail')).toBe(
      'previous@example.com',
    );
  });

  it('fails closed for wrong target, wrong field and tampered envelopes', () => {
    const ciphertext = service.encrypt(
      'person@example.com',
      'srep_bound',
      'contactEmail',
    );
    const tamperedParts = ciphertext.split('.');
    const ciphertextSegment = tamperedParts[4];
    if (!ciphertextSegment) throw new Error('Missing ciphertext segment');
    tamperedParts[4] = `${ciphertextSegment.startsWith('A') ? 'B' : 'A'}${ciphertextSegment.slice(1)}`;
    const tampered = tamperedParts.join('.');

    for (const candidate of [
      () => service.decrypt(ciphertext, 'srep_other', 'contactEmail'),
      () => service.decrypt(ciphertext, 'srep_bound', 'otherField'),
      () => service.decrypt(tampered, 'srep_bound', 'contactEmail'),
      () => service.decrypt('not-an-envelope', 'srep_bound', 'contactEmail'),
    ]) {
      expect(candidate).toThrow('Access-support ciphertext không hợp lệ');
    }
  });

  it('creates domain-separated deterministic HMAC and signed challenges', () => {
    expect(service.hmac('contact', 'value')).toBe(
      service.hmac('contact', 'value'),
    );
    expect(service.hmac('contact', 'value')).not.toBe(
      service.hmac('dedupe', 'value'),
    );
    const token = service.signChallenge('{"safe":true}');
    expect(service.verifyChallengeToken(token)).toBe('{"safe":true}');
    expect(service.verifyChallengeToken(`${token}x`)).toBeNull();
  });
});
