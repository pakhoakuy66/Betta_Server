import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import {
  ACCESS_SUPPORT_ENCRYPTED_PREFIX,
  ACCESS_SUPPORT_ENCRYPTION_AAD_DOMAIN,
} from '../constants/access-support.constants';
import { AccessSupportSecretsConfig } from '../config/access-support-secrets.config';

@Injectable()
export class AccessSupportCryptoService {
  constructor(private readonly secrets: AccessSupportSecretsConfig) {}

  encrypt(value: string, reportPublicId: string, field: string): string {
    const key = this.secrets.encryption.current;
    const iv = randomBytes(12);
    const aad = Buffer.from(
      `${ACCESS_SUPPORT_ENCRYPTION_AAD_DOMAIN}:${reportPublicId}:${field}`,
      'utf8',
    );
    const cipher = createCipheriv('aes-256-gcm', key.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      ACCESS_SUPPORT_ENCRYPTED_PREFIX,
      key.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  hmac(domain: string, value: string): string {
    const key = this.secrets.hmac.current;
    return `${key.id}.${this.digest(key.key, domain, value)}`;
  }

  hmacCandidates(domain: string, value: string): string[] {
    return this.secrets.hmac.all.map(
      (key) => `${key.id}.${this.digest(key.key, domain, value)}`,
    );
  }

  signChallenge(payload: string): string {
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${encoded}.${this.hmac('challenge', encoded)}`;
  }

  verifyChallengeToken(token: string): string | null {
    const separator = token.indexOf('.');
    if (separator <= 0) return null;
    const encoded = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    for (const candidate of this.hmacCandidates('challenge', encoded)) {
      const actual = Buffer.from(signature);
      const expected = Buffer.from(candidate);
      if (
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
      ) {
        try {
          return Buffer.from(encoded, 'base64url').toString('utf8');
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private digest(key: Buffer, domain: string, value: string): string {
    return createHmac('sha256', key)
      .update(`betta.access-support.${domain}.v1\0${value}`)
      .digest('hex');
  }
}
