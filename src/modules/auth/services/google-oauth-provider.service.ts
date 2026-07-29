import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type OAuth2Client, type TokenPayload } from 'google-auth-library';
import { type GoogleOAuthVerifiedIdentity } from '../interfaces/google-oauth-provider.interface';
import {
  GOOGLE_SUBJECT_MAX_LENGTH,
  GOOGLE_SUBJECT_PATTERN,
} from '../schemas/oauth-identity.schema';
import { SHA256_BASE64URL_PATTERN } from '../schemas/google-oauth-transaction.schema';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { GoogleOAuthClientFactory } from './google-oauth-client.factory';
import { GoogleOAuthTransactionService } from './google-oauth-transaction.service';

const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/u;

const MAX_CLIENT_SECRET_LENGTH = 2048;
const MAX_EMAIL_LENGTH = 254;
const MAX_FULLNAME_LENGTH = 200;
const MAX_AVATAR_URL_LENGTH = 2048;

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'TimeoutError',
]);

const CONFIGURATION_PROVIDER_ERRORS = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
  'server_error',
  'temporarily_unavailable',
]);

const containsAsciiControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }

  return false;
};

type UnknownRecord = Record<string, unknown>;

type ProviderErrorDetails = {
  networkCode: string | null;
  providerCode: string | null;
  status: number | null;
};

type ProviderRuntime = {
  client: OAuth2Client;
  clientId: string;
  callbackUrl: string;
};

@Injectable()
export class GoogleOAuthProviderService {
  private readonly runtime: ProviderRuntime | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly transactionService: GoogleOAuthTransactionService,
    clientFactory: GoogleOAuthClientFactory,
  ) {
    const configuration = this.transactionService.getProviderConfiguration();

    if (!configuration) {
      this.runtime = null;
      return;
    }

    const clientSecret = this.readClientSecret();

    this.runtime = {
      client: clientFactory.create(
        configuration.clientId,
        clientSecret,
        configuration.callbackUrl,
      ),
      clientId: configuration.clientId,
      callbackUrl: configuration.callbackUrl,
    };
  }

  async exchangeAuthorizationCode(
    authorizationCode: string,
    codeVerifier: string,
    expectedNonceHash: string,
  ): Promise<GoogleOAuthVerifiedIdentity> {
    const runtime = this.requireRuntime();

    this.assertAuthorizationCode(authorizationCode);

    this.assertCodeVerifier(codeVerifier);

    let idToken: string;

    try {
      const response = await runtime.client.getToken({
        code: authorizationCode,
        codeVerifier,
        redirect_uri: runtime.callbackUrl,
      });

      if (!response.tokens.id_token) {
        throw this.invalidIdentity();
      }

      idToken = response.tokens.id_token;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw this.mapTokenExchangeError(error);
    }

    let payload: TokenPayload | undefined;

    try {
      const ticket = await runtime.client.verifyIdToken({
        idToken,
        audience: runtime.clientId,
      });

      payload = ticket.getPayload();
    } catch (error: unknown) {
      throw this.mapIdTokenVerificationError(error);
    }

    if (!payload) {
      throw this.invalidIdentity();
    }

    this.assertAuthorizedParty(payload, runtime.clientId);

    const nonce = this.readStringField(payload, 'nonce');

    if (
      !nonce ||
      !this.transactionService.matchesNonce(nonce, expectedNonceHash)
    ) {
      throw this.invalidIdentity();
    }

    const providerAccountId = payload.sub;

    if (
      typeof providerAccountId !== 'string' ||
      providerAccountId.length === 0 ||
      providerAccountId.length > GOOGLE_SUBJECT_MAX_LENGTH ||
      !GOOGLE_SUBJECT_PATTERN.test(providerAccountId)
    ) {
      throw this.invalidIdentity();
    }

    const email =
      typeof payload.email === 'string'
        ? normalizeAuthEmail(payload.email)
        : undefined;

    if (
      payload.email_verified !== true ||
      !email ||
      email.length > MAX_EMAIL_LENGTH ||
      /\s/u.test(email) ||
      containsAsciiControlCharacter(email)
    ) {
      throw this.invalidIdentity();
    }

    return {
      providerAccountId,
      email,
      fullname: this.normalizeFullname(payload.name),
      avatar: this.normalizeAvatar(payload.picture),
    };
  }

  private assertAuthorizedParty(payload: TokenPayload, clientId: string): void {
    const rawAzp = (payload as unknown as Record<string, unknown>).azp;

    if (
      rawAzp !== undefined &&
      (typeof rawAzp !== 'string' || rawAzp !== clientId)
    ) {
      throw this.invalidIdentity();
    }
  }

  private readClientSecret(): string {
    const value = this.configService.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');

    if (
      !value ||
      value.length > MAX_CLIENT_SECRET_LENGTH ||
      value !== value.trim() ||
      /\s|\0/u.test(value)
    ) {
      throw new Error('GOOGLE_OAUTH_CLIENT_SECRET không hợp lệ');
    }

    return value;
  }

  private requireRuntime(): ProviderRuntime {
    if (!this.runtime) {
      throw new ServiceUnavailableException(
        'Đăng nhập Google hiện không khả dụng',
      );
    }

    return this.runtime;
  }

  private assertAuthorizationCode(value: string): void {
    if (typeof value !== 'string' || !AUTHORIZATION_CODE_PATTERN.test(value)) {
      throw this.invalidIdentity();
    }
  }

  private assertCodeVerifier(value: string): void {
    if (typeof value !== 'string' || !SHA256_BASE64URL_PATTERN.test(value)) {
      throw this.invalidIdentity();
    }
  }

  private normalizeFullname(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();

    if (
      !normalized ||
      normalized.length > MAX_FULLNAME_LENGTH ||
      containsAsciiControlCharacter(normalized)
    ) {
      return null;
    }

    return normalized;
  }

  private normalizeAvatar(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) {
      return null;
    }

    try {
      const url = new URL(value);

      if (url.protocol !== 'https:' || url.username || url.password) {
        return null;
      }

      return url.toString();
    } catch {
      return null;
    }
  }

  private readStringField(source: object, field: string): string | null {
    const value = (source as Record<string, unknown>)[field];

    return typeof value === 'string' ? value : null;
  }

  private mapTokenExchangeError(
    error: unknown,
  ): UnauthorizedException | ServiceUnavailableException {
    const details = this.readErrorDetails(error);

    /*
     * Authorization code sai, hết hạn,
     * đã dùng hoặc không còn hợp lệ.
     */
    if (details.providerCode === 'invalid_grant') {
      return this.invalidIdentity();
    }

    /*
     * HTTP 401 tại token endpoint là lỗi
     * xác thực OAuth client, không phải lỗi user.
     */
    if (
      this.isInfrastructureFailure(details) ||
      details.status === 401 ||
      (details.providerCode !== null &&
        CONFIGURATION_PROVIDER_ERRORS.has(details.providerCode))
    ) {
      return this.providerUnavailable();
    }

    return this.invalidIdentity();
  }

  private mapIdTokenVerificationError(
    error: unknown,
  ): UnauthorizedException | ServiceUnavailableException {
    const details = this.readErrorDetails(error);

    return this.isInfrastructureFailure(details)
      ? this.providerUnavailable()
      : this.invalidIdentity();
  }

  private isInfrastructureFailure(details: ProviderErrorDetails): boolean {
    return (
      (details.networkCode !== null &&
        NETWORK_ERROR_CODES.has(details.networkCode)) ||
      details.status === 408 ||
      details.status === 429 ||
      (details.status !== null && details.status >= 500)
    );
  }

  private readErrorDetails(error: unknown): ProviderErrorDetails {
    const root = this.asRecord(error);
    const cause = this.asRecord(root?.cause);
    const response = this.asRecord(root?.response);

    const responseData = this.asRecord(response?.data);

    return {
      networkCode:
        this.readString(root, 'code') ?? this.readString(cause, 'code'),

      status:
        this.readNumber(root, 'status') ?? this.readNumber(response, 'status'),

      providerCode:
        this.readString(responseData, 'error') ??
        this.readString(root, 'error'),
    };
  }

  private asRecord(value: unknown): UnknownRecord | null {
    return typeof value === 'object' && value !== null
      ? (value as UnknownRecord)
      : null;
  }

  private readString(
    source: UnknownRecord | null,
    field: string,
  ): string | null {
    const value = source?.[field];

    return typeof value === 'string' ? value : null;
  }

  private readNumber(
    source: UnknownRecord | null,
    field: string,
  ): number | null {
    const value = source?.[field];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private invalidIdentity(): UnauthorizedException {
    return new UnauthorizedException('Không thể xác minh đăng nhập Google');
  }

  private providerUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Không thể kết nối dịch vụ đăng nhập Google',
    );
  }
}
