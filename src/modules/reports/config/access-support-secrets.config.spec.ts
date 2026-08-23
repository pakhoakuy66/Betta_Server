import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AccessSupportSecretsConfig } from './access-support-secrets.config';

const keyring = (byte: number, id: string) =>
  JSON.stringify({
    current: { id, keyBase64: Buffer.alloc(32, byte).toString('base64') },
  });

describe('AccessSupportSecretsConfig', () => {
  it('loads separate canonical 32-byte keyrings', () => {
    const config = new ConfigService({
      ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: keyring(1, 'enc-v1'),
      ACCESS_SUPPORT_HMAC_KEYRING_JSON: keyring(2, 'hmac-v1'),
    });
    const secrets = new AccessSupportSecretsConfig(config);
    expect(secrets.encryption.current.id).toBe('enc-v1');
    expect(secrets.hmac.current.key).toHaveLength(32);
  });

  it('rejects missing, malformed and reused key material', () => {
    expect(
      () =>
        new AccessSupportSecretsConfig(
          new ConfigService({
            ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: '',
            ACCESS_SUPPORT_HMAC_KEYRING_JSON: '',
          }),
        ),
    ).toThrow();
    expect(
      () =>
        new AccessSupportSecretsConfig(
          new ConfigService({
            ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: keyring(1, 'enc-v1'),
            ACCESS_SUPPORT_HMAC_KEYRING_JSON: keyring(1, 'hmac-v1'),
          }),
        ),
    ).toThrow('phải dùng key khác nhau');
  });
});
