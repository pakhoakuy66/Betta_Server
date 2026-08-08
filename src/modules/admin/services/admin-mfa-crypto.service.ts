import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  ADMIN_RECOVERY_CODE_BYTES,
  ADMIN_RECOVERY_CODE_HASH_DOMAIN,
  ADMIN_TOTP_AAD_DOMAIN,
  ADMIN_TOTP_ENCRYPTED_PREFIX,
  ADMIN_TOTP_SECRET_BYTES,
} from '../constants/admin-mfa.constants';

@Injectable()
export class AdminMfaCryptoService {
  constructor(@Inject(ADMIN_SECRETS) private readonly secrets: AdminSecrets) {}

  generateTotpSecret(): Buffer {
    return randomBytes(ADMIN_TOTP_SECRET_BYTES);
  }

  encryptTotpSecret(secret: Buffer, adminPublicId: string): string {
    if (secret.length !== ADMIN_TOTP_SECRET_BYTES) {
      throw new TypeError('Admin TOTP secret không hợp lệ');
    }
    const key = this.secrets.current(AdminSecretPurpose.TOTP_ENCRYPTION);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, iv);
    cipher.setAAD(this.aad(adminPublicId));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ADMIN_TOTP_ENCRYPTED_PREFIX,
      key.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  decryptTotpSecret(envelope: string, adminPublicId: string): Buffer {
    const [prefix, keyId, ivValue, ciphertextValue, tagValue, extra] =
      envelope.split('.');
    if (
      prefix !== ADMIN_TOTP_ENCRYPTED_PREFIX ||
      !keyId ||
      !ivValue ||
      !ciphertextValue ||
      !tagValue ||
      extra !== undefined
    ) {
      throw new Error('Admin TOTP secret không khả dụng');
    }
    try {
      const key = this.secrets.resolve(
        AdminSecretPurpose.TOTP_ENCRYPTION,
        keyId,
      );
      const iv = Buffer.from(ivValue, 'base64url');
      const ciphertext = Buffer.from(ciphertextValue, 'base64url');
      const tag = Buffer.from(tagValue, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
      decipher.setAAD(this.aad(adminPublicId));
      decipher.setAuthTag(tag);
      const secret = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (secret.length !== ADMIN_TOTP_SECRET_BYTES) throw new Error();
      return secret;
    } catch {
      throw new Error('Admin TOTP secret không khả dụng');
    }
  }

  generateRecoveryCodes(count: number): readonly string[] {
    return Object.freeze(
      Array.from({ length: count }, () =>
        randomBytes(ADMIN_RECOVERY_CODE_BYTES).toString('base64url'),
      ),
    );
  }

  hashRecoveryCode(code: unknown): string {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(code)) {
      return createHash('sha256')
        .update(`${ADMIN_RECOVERY_CODE_HASH_DOMAIN}\0invalid`)
        .digest('hex');
    }
    return createHash('sha256')
      .update(`${ADMIN_RECOVERY_CODE_HASH_DOMAIN}\0${code}`)
      .digest('hex');
  }

  private aad(adminPublicId: string): Buffer {
    return Buffer.from(`${ADMIN_TOTP_AAD_DOMAIN}\0${adminPublicId}`, 'utf8');
  }
}
