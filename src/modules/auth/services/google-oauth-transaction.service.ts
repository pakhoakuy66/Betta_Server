import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import {
  type ConsumedGoogleOAuthTransaction,
  type GoogleOAuthAuthorizationStart,
  type GoogleOAuthProviderConfiguration,
} from '../interfaces/google-oauth-transaction.interface';
import {
  GoogleOAuthTransaction,
  SHA256_BASE64URL_PATTERN,
} from '../schemas/google-oauth-transaction.schema';
import { GOOGLE_OAUTH_CALLBACK_PATH } from '../constants/google-oauth-route.constants';
import { GoogleOAuthTransactionInvalidException } from '../exceptions/google-oauth-transaction-invalid.exception';

const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';

const DEFAULT_TRANSACTION_TTL_SECONDS = 600;
const MIN_TRANSACTION_TTL_SECONDS = 300;
const MAX_TRANSACTION_TTL_SECONDS = 900;

const OPAQUE_SECRET_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const MAX_GOOGLE_CLIENT_ID_LENGTH = 512;

const TRANSACTION_SECRET_SELECTION = [
  '+nonceHash',
  '+codeVerifierCiphertext',
  '+codeVerifierIv',
  '+codeVerifierAuthTag',
].join(' ');

type AppEnvironment = 'developer' | 'test' | 'production';

const APP_ENVIRONMENTS = new Set<AppEnvironment>([
  'developer',
  'test',
  'production',
]);

type GoogleOAuthSettings = {
  clientId: string;
  callbackUrl: string;
  encryptionKey: Buffer;
  transactionTtlMs: number;
};

type EncryptedVerifier = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

type StoredTransactionSecrets = {
  nonceHash: string;
  codeVerifierCiphertext: string;
  codeVerifierIv: string;
  codeVerifierAuthTag: string;
};

@Injectable()
export class GoogleOAuthTransactionService {
  private readonly settings: GoogleOAuthSettings | null;

  constructor(
    @InjectModel(GoogleOAuthTransaction.name)
    private readonly transactionModel: Model<GoogleOAuthTransaction>,
    private readonly configService: ConfigService,
  ) {
    this.settings = this.readEnabled() ? this.readSettings() : null;
  }

  getProviderConfiguration(): GoogleOAuthProviderConfiguration | null {
    if (!this.settings) {
      return null;
    }

    return {
      clientId: this.settings.clientId,
      callbackUrl: this.settings.callbackUrl,
    };
  }

  async beginAuthorization(): Promise<GoogleOAuthAuthorizationStart> {
    const settings = this.requireEnabledSettings();

    const state = this.generateOpaqueSecret();
    const nonce = this.generateOpaqueSecret();
    const codeVerifier = this.generateOpaqueSecret();

    const stateHash = this.sha256Base64Url(state);
    const nonceHash = this.sha256Base64Url(nonce);
    const codeChallenge = this.sha256Base64Url(codeVerifier);

    const encryptedVerifier = this.encryptCodeVerifier(
      codeVerifier,
      settings.encryptionKey,
      stateHash,
      nonceHash,
    );

    const expiresAt = new Date(Date.now() + settings.transactionTtlMs);

    await this.transactionModel.create({
      stateHash,
      nonceHash,
      codeVerifierCiphertext: encryptedVerifier.ciphertext,
      codeVerifierIv: encryptedVerifier.iv,
      codeVerifierAuthTag: encryptedVerifier.authTag,
      expiresAt,
      consumedAt: null,
    });

    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);

    authorizationUrl.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();

    return {
      authorizationUrl: authorizationUrl.toString(),
      browserState: state,
      expiresAt,
    };
  }

  async consumeAuthorization(
    callbackState: string,
    browserState: string,
  ): Promise<ConsumedGoogleOAuthTransaction> {
    const settings = this.requireEnabledSettings();

    if (
      !this.isOpaqueSecret(callbackState) ||
      !this.isOpaqueSecret(browserState) ||
      !this.safeEqual(callbackState, browserState)
    ) {
      throw this.invalidTransaction();
    }

    const stateHash = this.sha256Base64Url(callbackState);

    const now = new Date();

    const transaction = await this.transactionModel
      .findOneAndUpdate(
        {
          stateHash,
          consumedAt: null,
          expiresAt: {
            $gt: now,
          },
        },
        {
          $set: {
            consumedAt: now,
          },
        },
        {
          returnDocument: 'after',
        },
      )
      .select(TRANSACTION_SECRET_SELECTION)
      .lean<StoredTransactionSecrets>()
      .exec();

    if (!transaction) {
      throw this.invalidTransaction();
    }

    try {
      const codeVerifier = this.decryptCodeVerifier(
        transaction,
        settings.encryptionKey,
        stateHash,
      );

      return {
        codeVerifier,
        expectedNonceHash: transaction.nonceHash,
      };
    } catch {
      // Transaction đã được consume có chủ ý.
      // Không rollback để dữ liệu hỏng không thể retry.
      throw new ServiceUnavailableException(
        'Không thể hoàn tất đăng nhập Google',
      );
    }
  }

  matchesNonce(nonce: string, expectedNonceHash: string): boolean {
    if (
      !this.isOpaqueSecret(nonce) ||
      !SHA256_BASE64URL_PATTERN.test(expectedNonceHash)
    ) {
      return false;
    }

    return this.safeEqual(this.sha256Base64Url(nonce), expectedNonceHash);
  }

  private readSettings(): GoogleOAuthSettings {
    const environment = this.readEnvironment();

    const clientId = this.readClientId();

    const callbackUrl = this.readCallbackUrl(environment);

    const encryptionKey = this.readEncryptionKey();

    const transactionTtlMs = this.readTransactionTtlSeconds() * 1_000;

    return {
      clientId,
      callbackUrl,
      encryptionKey,
      transactionTtlMs,
    };
  }

  private readEnabled(): boolean {
    const value = this.configService.get<string>('GOOGLE_OAUTH_ENABLED');

    if (!value || value.trim() === '') {
      return false;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }

    throw new Error('GOOGLE_OAUTH_ENABLED phải là true hoặc false');
  }

  private readEnvironment(): AppEnvironment {
    const value = this.configService.get<string>('NODE_ENV');

    if (!value || !APP_ENVIRONMENTS.has(value as AppEnvironment)) {
      throw new Error('NODE_ENV phải là developer, test hoặc production');
    }

    return value as AppEnvironment;
  }

  private readClientId(): string {
    const value = this.readRequired('GOOGLE_OAUTH_CLIENT_ID');

    if (value.length > MAX_GOOGLE_CLIENT_ID_LENGTH || /\s/u.test(value)) {
      throw new Error('GOOGLE_OAUTH_CLIENT_ID không hợp lệ');
    }

    return value;
  }

  private readCallbackUrl(environment: AppEnvironment): string {
    const value = this.readRequired('GOOGLE_OAUTH_CALLBACK_URL');

    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new Error('GOOGLE_OAUTH_CALLBACK_URL không hợp lệ');
    }

    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        'GOOGLE_OAUTH_CALLBACK_URL không được chứa credentials, query hoặc fragment',
      );
    }

    if (url.pathname !== GOOGLE_OAUTH_CALLBACK_PATH) {
      throw new Error(
        'GOOGLE_OAUTH_CALLBACK_URL phải trỏ đúng Google OAuth callback path',
      );
    }

    const isLoopback = this.isLoopbackHostname(url.hostname);

    if (environment === 'production') {
      if (url.protocol !== 'https:' || isLoopback) {
        throw new Error(
          'Google OAuth callback production phải dùng HTTPS và không được là loopback',
        );
      }

      return url.toString();
    }

    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopback)
    ) {
      throw new Error(
        'Google OAuth callback HTTP chỉ được dùng với loopback trong developer hoặc test',
      );
    }

    return url.toString();
  }

  private isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, '')
      .replace(/\.$/u, '');

    if (
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized === '::1' ||
      normalized.startsWith('::ffff:7f') ||
      /^::ffff:127(?:\.|$)/u.test(normalized)
    ) {
      return true;
    }

    return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
  }

  private readEncryptionKey(): Buffer {
    const encodedKey = this.readRequired('GOOGLE_OAUTH_TRANSACTION_KEY_BASE64');

    const key = Buffer.from(encodedKey, 'base64');

    if (
      key.length !== AES_256_KEY_BYTES ||
      key.toString('base64') !== encodedKey
    ) {
      throw new Error(
        'GOOGLE_OAUTH_TRANSACTION_KEY_BASE64 phải là Base64 canonical của khóa 32 byte',
      );
    }

    return key;
  }

  private readTransactionTtlSeconds(): number {
    const raw = this.configService.get<string>(
      'GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS',
    );

    if (!raw || raw.trim() === '') {
      return DEFAULT_TRANSACTION_TTL_SECONDS;
    }

    const normalized = raw.trim();

    if (!/^\d+$/u.test(normalized)) {
      throw new Error('GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS phải là số nguyên');
    }

    const value = Number(normalized);

    if (
      value < MIN_TRANSACTION_TTL_SECONDS ||
      value > MAX_TRANSACTION_TTL_SECONDS
    ) {
      throw new Error(
        'GOOGLE_OAUTH_TRANSACTION_TTL_SECONDS phải từ 300 đến 900',
      );
    }

    return value;
  }

  private readRequired(key: string): string {
    const value = this.configService.get<string>(key)?.trim();

    if (!value) {
      throw new Error(`${key} là bắt buộc khi Google OAuth được bật`);
    }

    return value;
  }

  private requireEnabledSettings(): GoogleOAuthSettings {
    if (!this.settings) {
      throw new ServiceUnavailableException(
        'Đăng nhập Google hiện không khả dụng',
      );
    }

    return this.settings;
  }

  private generateOpaqueSecret(): string {
    return randomBytes(OPAQUE_SECRET_BYTES).toString('base64url');
  }

  private sha256Base64Url(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('base64url');
  }

  private encryptCodeVerifier(
    codeVerifier: string,
    encryptionKey: Buffer,
    stateHash: string,
    nonceHash: string,
  ): EncryptedVerifier {
    const iv = randomBytes(AES_GCM_IV_BYTES);

    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, {
      authTagLength: AES_GCM_AUTH_TAG_BYTES,
    });

    cipher.setAAD(this.createAdditionalAuthenticatedData(stateHash, nonceHash));

    const encrypted = Buffer.concat([
      cipher.update(codeVerifier, 'utf8'),
      cipher.final(),
    ]);

    return {
      ciphertext: encrypted.toString('base64url'),
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    };
  }

  private decryptCodeVerifier(
    transaction: StoredTransactionSecrets,
    encryptionKey: Buffer,
    stateHash: string,
  ): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(transaction.codeVerifierIv, 'base64url'),
      {
        authTagLength: AES_GCM_AUTH_TAG_BYTES,
      },
    );

    decipher.setAAD(
      this.createAdditionalAuthenticatedData(stateHash, transaction.nonceHash),
    );

    decipher.setAuthTag(
      Buffer.from(transaction.codeVerifierAuthTag, 'base64url'),
    );

    const decrypted = Buffer.concat([
      decipher.update(
        Buffer.from(transaction.codeVerifierCiphertext, 'base64url'),
      ),
      decipher.final(),
    ]);

    const verifier = decrypted.toString('utf8');

    if (!this.isOpaqueSecret(verifier)) {
      throw new Error('Invalid decrypted PKCE verifier');
    }

    return verifier;
  }

  private createAdditionalAuthenticatedData(
    stateHash: string,
    nonceHash: string,
  ): Buffer {
    return Buffer.from(`${stateHash}.${nonceHash}`, 'utf8');
  }

  private isOpaqueSecret(value: unknown): value is string {
    return typeof value === 'string' && SHA256_BASE64URL_PATTERN.test(value);
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');

    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }

  private invalidTransaction(): GoogleOAuthTransactionInvalidException {
    return new GoogleOAuthTransactionInvalidException();
  }
}
