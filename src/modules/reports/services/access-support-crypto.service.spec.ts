import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AccessSupportSecretsConfig } from '../config/access-support-secrets.config';
import { AccessSupportCryptoService } from './access-support-crypto.service';

const keyring = (byte: number, id: string) =>
  JSON.stringify({
    current: { id, keyBase64: Buffer.alloc(32, byte).toString('base64') },
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
