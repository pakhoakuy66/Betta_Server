import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model } from 'mongoose';

import {
  BASE64URL_PATTERN,
  GOOGLE_OAUTH_SESSION_HANDOFF_AAD_CONTEXT,
  GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BYTES,
  GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_DEFAULT_TTL_SECONDS,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_IV_BYTES,
  GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BYTES,
  GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_MAX_TTL_SECONDS,
  GOOGLE_OAUTH_SESSION_HANDOFF_MIN_TTL_SECONDS,
  GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
  GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BYTES,
} from '../constants/google-oauth-session-handoff.constants';
import { GoogleOAuthSessionHandoffInvalidException } from '../exceptions/google-oauth-session-handoff-invalid.exception';
import type { AuthResponse } from '../interfaces/auth.interface';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';
import { GoogleOAuthSessionHandoff } from '../schemas/google-oauth-session-handoff.schema';

const SECRET_HANDOFF_SELECTION = [
  '+handoffHash',
  '+payloadVersion',
  '+payloadCiphertext',
  '+payloadIv',
  '+payloadAuthTag',
].join(' ');

const MAX_MESSAGE_LENGTH = 512;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_USER_STRING_LENGTH = 2_048;

type HandoffSettings = {
  encryptionKey: Buffer;
  ttlMilliseconds: number;
};

type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

type StoredHandoffEnvelope = {
  handoffHash: string;
  payloadVersion: number;
  payloadCiphertext: string;
  payloadIv: string;
  payloadAuthTag: string;
  expiresAt: Date;
};

@Injectable()
export class GoogleOAuthSessionHandoffService {
  private readonly settings: HandoffSettings | null;

  constructor(
    @InjectModel(GoogleOAuthSessionHandoff.name)
    private readonly handoffModel: Model<GoogleOAuthSessionHandoff>,
    private readonly configService: ConfigService,
  ) {
    this.settings = this.readEnabled() ? this.readSettings() : null;
  }

  async issue(
    authResponse: AuthResponse,
    mongoSession: ClientSession,
  ): Promise<IssuedGoogleOAuthSessionHandoff> {
    this.assertActiveTransaction(mongoSession);

    const settings = this.requireEnabledSettings();
    const payload = this.projectAuthResponse(authResponse);
    const rawHandoff = randomBytes(
      GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BYTES,
    ).toString('base64url');
    const handoffHash = this.hashHandoff(rawHandoff);
    const expiresAt = new Date(Date.now() + settings.ttlMilliseconds);

    try {
      const encrypted = this.encryptPayload(
        payload,
        settings.encryptionKey,
        handoffHash,
        expiresAt,
      );

      await this.handoffModel.insertMany(
        [
          {
            handoffHash,
            payloadVersion: GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
            payloadCiphertext: encrypted.ciphertext,
            payloadIv: encrypted.iv,
            payloadAuthTag: encrypted.authTag,
            expiresAt,
            consumedAt: null,
          },
        ],
        {
          ordered: true,
          session: mongoSession,
        },
      );

      return {
        rawHandoff,
        expiresAt,
      };
    } catch {
      throw this.unavailable();
    }
  }

  async consume(rawHandoff: string): Promise<AuthResponse> {
    const settings = this.requireEnabledSettings();

    if (!this.isCanonicalRawHandoff(rawHandoff)) {
      throw this.invalidHandoff();
    }

    const handoffHash = this.hashHandoff(rawHandoff);
    const now = new Date();

    let envelope: StoredHandoffEnvelope | null;

    try {
      envelope = await this.handoffModel
        .findOneAndUpdate(
          {
            handoffHash,
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
            runValidators: true,
          },
        )
        .select(SECRET_HANDOFF_SELECTION)
        .lean<StoredHandoffEnvelope | null>()
        .exec();
    } catch {
      throw this.unavailable();
    }

    if (!envelope) {
      throw this.invalidHandoff();
    }

    try {
      this.assertEnvelope(envelope, handoffHash);

      return this.decryptPayload(envelope, settings.encryptionKey);
    } catch {
      // consumedAt đã được ghi có chủ ý: payload hỏng phải fail-closed.
      throw this.unavailable();
    }
  }

  private readSettings(): HandoffSettings {
    const encryptionKey = this.readEncryptionKey();

    this.assertDedicatedKey(encryptionKey);

    return {
      encryptionKey,
      ttlMilliseconds: this.readTtlSeconds() * 1_000,
    };
  }

  private readEnabled(): boolean {
    const raw = this.configService.get<string | boolean>(
      'GOOGLE_OAUTH_ENABLED',
    );

    if (raw === undefined || raw === null) {
      return false;
    }

    if (typeof raw === 'boolean') {
      return raw;
    }

    const normalized = raw.trim().toLowerCase();

    if (normalized === '') {
      return false;
    }

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }

    throw new Error('GOOGLE_OAUTH_ENABLED phải là true hoặc false');
  }

  private readEncryptionKey(): Buffer {
    const encoded = this.configService
      .get<string>('GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64')
      ?.trim();

    if (!encoded) {
      throw new Error(
        'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64 là bắt buộc khi Google OAuth được bật',
      );
    }

    const key = Buffer.from(encoded, 'base64');

    if (
      key.length !== GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BYTES ||
      key.toString('base64') !== encoded
    ) {
      throw new Error(
        'GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64 phải là Base64 canonical của khóa 32 byte',
      );
    }

    return key;
  }

  private assertDedicatedKey(key: Buffer): void {
    const secretNames = [
      'GOOGLE_OAUTH_TRANSACTION_KEY_BASE64',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
    ] as const;

    for (const name of secretNames) {
      const raw = this.configService.get<string>(name)?.trim();

      if (!raw) {
        continue;
      }

      const candidates = [Buffer.from(raw, 'utf8')];
      const decoded = Buffer.from(raw, 'base64');

      if (decoded.toString('base64') === raw) {
        candidates.push(decoded);
      }

      if (
        candidates.some(
          (candidate) =>
            candidate.length === key.length && timingSafeEqual(candidate, key),
        )
      ) {
        throw new Error(
          `GOOGLE_OAUTH_SESSION_HANDOFF_KEY_BASE64 không được dùng chung ${name}`,
        );
      }
    }
  }

  private readTtlSeconds(): number {
    const raw = this.configService.get<string | number>(
      'GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS',
    );

    if (raw === undefined || raw === null) {
      return GOOGLE_OAUTH_SESSION_HANDOFF_DEFAULT_TTL_SECONDS;
    }

    const normalized = typeof raw === 'number' ? String(raw) : raw.trim();

    if (normalized === '') {
      return GOOGLE_OAUTH_SESSION_HANDOFF_DEFAULT_TTL_SECONDS;
    }

    if (!/^\d+$/u.test(normalized)) {
      throw new Error(
        'GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS phải là số nguyên',
      );
    }

    const value = Number(normalized);

    if (
      value < GOOGLE_OAUTH_SESSION_HANDOFF_MIN_TTL_SECONDS ||
      value > GOOGLE_OAUTH_SESSION_HANDOFF_MAX_TTL_SECONDS
    ) {
      throw new Error(
        'GOOGLE_OAUTH_SESSION_HANDOFF_TTL_SECONDS phải từ 60 đến 300',
      );
    }

    return value;
  }

  private requireEnabledSettings(): HandoffSettings {
    if (!this.settings) {
      throw this.unavailable();
    }

    return this.settings;
  }

  private assertActiveTransaction(mongoSession: ClientSession): void {
    if (!mongoSession || !mongoSession.inTransaction()) {
      throw new TypeError(
        'Google OAuth session handoff issuance requires an active transaction',
      );
    }
  }

  private encryptPayload(
    payload: AuthResponse,
    key: Buffer,
    handoffHash: string,
    expiresAt: Date,
  ): EncryptedPayload {
    const iv = randomBytes(GOOGLE_OAUTH_SESSION_HANDOFF_IV_BYTES);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');

    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BYTES,
      });

      cipher.setAAD(this.createAad(handoffHash, expiresAt));

      const encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);

      const ciphertext = encrypted.toString('base64url');

      if (
        ciphertext.length === 0 ||
        ciphertext.length > GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH
      ) {
        throw new Error('Encrypted handoff payload is too large');
      }

      return {
        ciphertext,
        iv: iv.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  private decryptPayload(
    envelope: StoredHandoffEnvelope,
    key: Buffer,
  ): AuthResponse {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.payloadIv, 'base64url'),
      {
        authTagLength: GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BYTES,
      },
    );

    decipher.setAAD(this.createAad(envelope.handoffHash, envelope.expiresAt));
    decipher.setAuthTag(Buffer.from(envelope.payloadAuthTag, 'base64url'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.payloadCiphertext, 'base64url')),
      decipher.final(),
    ]);

    try {
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

      return this.projectAuthResponse(parsed);
    } finally {
      plaintext.fill(0);
    }
  }

  private createAad(handoffHash: string, expiresAt: Date): Buffer {
    return Buffer.from(
      [
        GOOGLE_OAUTH_SESSION_HANDOFF_AAD_CONTEXT,
        GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
        handoffHash,
        expiresAt.getTime(),
      ].join('.'),
      'utf8',
    );
  }

  private assertEnvelope(
    envelope: StoredHandoffEnvelope,
    expectedHash: string,
  ): void {
    if (
      envelope.payloadVersion !==
        GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION ||
      !(envelope.expiresAt instanceof Date) ||
      !Number.isFinite(envelope.expiresAt.getTime()) ||
      envelope.handoffHash !== expectedHash ||
      !this.isCanonicalBase64Url(
        envelope.handoffHash,
        GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
        GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BYTES,
      ) ||
      !this.isCanonicalBase64Url(
        envelope.payloadIv,
        GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
        GOOGLE_OAUTH_SESSION_HANDOFF_IV_BYTES,
      ) ||
      !this.isCanonicalBase64Url(
        envelope.payloadAuthTag,
        GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
        GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BYTES,
      ) ||
      !this.isCanonicalCiphertext(envelope.payloadCiphertext)
    ) {
      throw new Error('Invalid encrypted handoff envelope');
    }
  }

  private isCanonicalRawHandoff(value: unknown): value is string {
    return this.isCanonicalBase64Url(
      value,
      GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BASE64URL_LENGTH,
      GOOGLE_OAUTH_SESSION_HANDOFF_RAW_BYTES,
    );
  }

  private isCanonicalCiphertext(value: unknown): value is string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH ||
      !BASE64URL_PATTERN.test(value)
    ) {
      return false;
    }

    const decoded = Buffer.from(value, 'base64url');

    return decoded.length > 0 && decoded.toString('base64url') === value;
  }

  private isCanonicalBase64Url(
    value: unknown,
    encodedLength: number,
    decodedLength: number,
  ): value is string {
    if (
      typeof value !== 'string' ||
      value.length !== encodedLength ||
      !BASE64URL_PATTERN.test(value)
    ) {
      return false;
    }

    const decoded = Buffer.from(value, 'base64url');

    return (
      decoded.length === decodedLength &&
      decoded.toString('base64url') === value
    );
  }

  private hashHandoff(rawHandoff: string): string {
    return createHash('sha256').update(rawHandoff, 'utf8').digest('base64url');
  }

  private projectAuthResponse(value: unknown): AuthResponse {
    const source = this.requireRecord(value);
    const user = this.requireRecord(source.user);
    const notifications = this.requireRecord(user.notificationSettings);

    return {
      message: this.requireString(source.message, MAX_MESSAGE_LENGTH),
      access_token: this.requireString(source.access_token, MAX_TOKEN_LENGTH),
      refresh_token: this.requireString(source.refresh_token, MAX_TOKEN_LENGTH),
      user: {
        id: this.requireString(user.id, MAX_USER_STRING_LENGTH),
        publicId: this.requireString(user.publicId, MAX_USER_STRING_LENGTH),
        username: this.requireString(user.username, MAX_USER_STRING_LENGTH),
        fullname: this.requireString(user.fullname, MAX_USER_STRING_LENGTH),
        email: this.requireString(user.email, MAX_USER_STRING_LENGTH),
        phone: this.requireString(user.phone, MAX_USER_STRING_LENGTH),
        avatar: this.requireNullableString(user.avatar, MAX_USER_STRING_LENGTH),
        hasCustomAvatar: this.requireBoolean(user.hasCustomAvatar),
        streakCount: this.requireNonNegativeInteger(user.streakCount),
        status: this.requireString(user.status, MAX_USER_STRING_LENGTH),
        notificationSettings: {
          enabled: this.requireBoolean(notifications.enabled),
          follow: this.requireBoolean(notifications.follow),
          reaction: this.requireBoolean(notifications.reaction),
          recap: this.requireBoolean(notifications.recap),
        },
      },
    };
  }

  private requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Invalid AuthResponse object');
    }

    return value as Record<string, unknown>;
  }

  private requireString(value: unknown, maxLength: number): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maxLength
    ) {
      throw new TypeError('Invalid AuthResponse string');
    }

    return value;
  }

  private requireNullableString(
    value: unknown,
    maxLength: number,
  ): string | null {
    if (value === null) {
      return null;
    }

    return this.requireString(value, maxLength);
  }

  private requireBoolean(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new TypeError('Invalid AuthResponse boolean');
    }

    return value;
  }

  private requireNonNegativeInteger(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new TypeError('Invalid AuthResponse integer');
    }

    return value;
  }

  private invalidHandoff(): GoogleOAuthSessionHandoffInvalidException {
    return new GoogleOAuthSessionHandoffInvalidException();
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Không thể hoàn tất đăng nhập Google',
    );
  }
}
