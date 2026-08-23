import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AccessSupportKey = Readonly<{
  id: string;
  key: Buffer;
}>;

type SerializedKeyring = {
  current: { id: string; keyBase64: string };
  previous?: Array<{ id: string; keyBase64: string }>;
};

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

@Injectable()
export class AccessSupportSecretsConfig {
  readonly encryption: Readonly<{
    current: AccessSupportKey;
    all: readonly AccessSupportKey[];
  }>;
  readonly hmac: Readonly<{
    current: AccessSupportKey;
    all: readonly AccessSupportKey[];
  }>;

  constructor(config: ConfigService) {
    this.encryption = this.parse(
      config.get<string>('ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON'),
      'ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON',
    );
    this.hmac = this.parse(
      config.get<string>('ACCESS_SUPPORT_HMAC_KEYRING_JSON'),
      'ACCESS_SUPPORT_HMAC_KEYRING_JSON',
    );

    const encryptionMaterials = new Set(
      this.encryption.all.map((entry) => entry.key.toString('hex')),
    );
    if (
      this.hmac.all.some((entry) =>
        encryptionMaterials.has(entry.key.toString('hex')),
      )
    ) {
      throw new Error(
        'Access-support encryption và HMAC phải dùng key khác nhau',
      );
    }
  }

  private parse(
    raw: string | undefined,
    variableName: string,
  ): { current: AccessSupportKey; all: readonly AccessSupportKey[] } {
    if (!raw) throw new Error(`${variableName} chưa được cấu hình`);

    let value: SerializedKeyring;
    try {
      value = JSON.parse(raw) as SerializedKeyring;
    } catch {
      throw new Error(`${variableName} không phải JSON hợp lệ`);
    }

    if (!value || typeof value !== 'object' || !value.current) {
      throw new Error(`${variableName} thiếu current key`);
    }

    const entries = [value.current, ...(value.previous ?? [])].map((entry) => {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !KEY_ID_PATTERN.test(entry.id) ||
        typeof entry.keyBase64 !== 'string'
      ) {
        throw new Error(`${variableName} chứa key không hợp lệ`);
      }

      const key = Buffer.from(entry.keyBase64, 'base64');
      if (key.length !== 32 || key.toString('base64') !== entry.keyBase64) {
        throw new Error(
          `${variableName} chỉ chấp nhận canonical Base64 32-byte`,
        );
      }
      return Object.freeze({ id: entry.id, key });
    });

    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error(`${variableName} chứa key id trùng nhau`);
    }

    return Object.freeze({ current: entries[0], all: Object.freeze(entries) });
  }
}
