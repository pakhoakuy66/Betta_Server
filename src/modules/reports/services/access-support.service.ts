import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { Model } from 'mongoose';
import {
  ACCESS_SUPPORT_ACKNOWLEDGEMENT,
  ACCESS_SUPPORT_DEDUPE_WINDOW_SECONDS,
  ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH,
  ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH,
  ACCESS_SUPPORT_SENSITIVE_DATA_MESSAGE,
} from '../constants/access-support.constants';
import { AccessSupportRequestDto } from '../dto/access-support-request.dto';
import {
  SystemReport,
  SystemReportSource,
  SystemReportType,
} from '../schemas/system-report.schema';
import { AccessSupportCryptoService } from './access-support-crypto.service';
import { AccessSupportDedupeService } from './access-support-dedupe.service';
import { AccessSupportRateLimitService } from './access-support-rate-limit.service';
import { maskAccessSupportContactEmail } from '../utils/mask-access-support-contact.util';

const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:access[_ -]?token|refresh[_ -]?token|password|mật khẩu|recovery[_ -]?code|mã khôi phục)\b\s*[:=]/iu,
  /(?:^|[^\p{L}\p{N}_])(?:access[_ -]?token|refresh[_ -]?token|password|mật\s+khẩu|recovery[_ -]?code|mã\s+khôi\s+phục|otp|one[_ -]?time[_ -]?password|mã\s+(?:otp|xác\s+thực))\s*(?:của\s+(?:tôi|mình)\s*)?(?::|=|là(?:\s|$)|is(?:\s|$))/iu,
  /\b(?:otp|one[_ -]?time[_ -]?password)\b\D{0,8}\d{4,8}\b/iu,
];

export type AccessSupportResponse = Readonly<{
  reportPublicId: string;
  message: string;
}>;

@Injectable()
export class AccessSupportService {
  constructor(
    @InjectModel(SystemReport.name)
    private readonly model: Model<SystemReport>,
    private readonly crypto: AccessSupportCryptoService,
    private readonly rateLimit: AccessSupportRateLimitService,
    private readonly dedupe: AccessSupportDedupeService,
  ) {}

  async submit(
    dto: AccessSupportRequestDto,
    clientIp?: string,
    challengeHeader?: string,
    ipAttemptAlreadyConsumed = false,
  ): Promise<AccessSupportResponse> {
    try {
      return await this.submitInternal(
        dto,
        clientIp,
        challengeHeader,
        ipAttemptAlreadyConsumed,
      );
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Không thể ghi nhận yêu cầu hỗ trợ vào lúc này',
      );
    }
  }

  private async submitInternal(
    dto: AccessSupportRequestDto,
    clientIp?: string,
    challengeHeader?: string,
    ipAttemptAlreadyConsumed = false,
  ): Promise<AccessSupportResponse> {
    const normalized = this.normalize(dto);
    this.assertNormalizedDescriptionLength(normalized.description);

    const fingerprintInput = JSON.stringify({
      category: normalized.category,
      contactEmail: normalized.contactEmail,
      description: normalized.description,
      accountEmailOrUsername: normalized.accountEmailOrUsername ?? null,
    });
    const requestFingerprint = this.crypto.hmac('dedupe', fingerprintInput);

    if (!ipAttemptAlreadyConsumed) {
      await this.rateLimit.consumeIp(
        clientIp,
        requestFingerprint,
        challengeHeader,
      );
    }

    const contactLookupHmac = this.crypto.hmac(
      'contact-lookup',
      normalized.contactEmail,
    );
    await this.rateLimit.consumeContact(contactLookupHmac);

    this.assertNoCredentialMaterial([
      normalized.description,
      normalized.accountEmailOrUsername ?? '',
    ]);

    const duplicate = await this.findDuplicate(requestFingerprint);
    if (duplicate?.publicId) return this.response(duplicate.publicId);

    const { reportPublicId } = await this.dedupe.claim(requestFingerprint);
    const descriptionHash = createHash('sha256')
      .update(normalized.description)
      .digest('hex');

    try {
      const created = await this.model.create({
        publicId: reportPublicId,
        reporterId: null,
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        category: normalized.category,
        encryptedContactEmail: this.crypto.encrypt(
          normalized.contactEmail,
          reportPublicId,
          'contactEmail',
        ),
        contactEmailMasked: maskAccessSupportContactEmail(
          normalized.contactEmail,
        ),
        contactLookupHmac,
        encryptedAccountIdentifier: normalized.accountEmailOrUsername
          ? this.crypto.encrypt(
              normalized.accountEmailOrUsername,
              reportPublicId,
              'accountEmailOrUsername',
            )
          : null,
        description: normalized.description,
        descriptionHash,
        requestFingerprintHmac: requestFingerprint,
        dedupeKey: `access-support:${requestFingerprint}:${reportPublicId}`,
        correlationId: normalized.correlationId ?? null,
        evidenceImages: [],
      });
      return this.response(created.publicId ?? reportPublicId);
    } catch (error: unknown) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const concurrent = await this.model
        .findOne({ publicId: reportPublicId })
        .select('publicId')
        .lean<{ publicId: string }>()
        .exec();
      if (!concurrent?.publicId) throw error;
      return this.response(concurrent.publicId);
    }
  }

  private normalize(dto: AccessSupportRequestDto): AccessSupportRequestDto {
    return {
      category: dto.category,
      contactEmail: dto.contactEmail.trim().toLowerCase(),
      description: this.cleanText(dto.description),
      ...(dto.accountEmailOrUsername
        ? { accountEmailOrUsername: this.cleanText(dto.accountEmailOrUsername) }
        : {}),
      ...(dto.correlationId ? { correlationId: dto.correlationId.trim() } : {}),
    };
  }

  private cleanText(value: string): string {
    return value
      .replace(/\r\n?/gu, '\n')
      .split('')
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || (code >= 32 && code !== 127);
      })
      .join('')
      .trim();
  }

  private assertNormalizedDescriptionLength(value: string): void {
    const length = Array.from(value).length;
    if (
      length < ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH ||
      length > ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH
    ) {
      throw new BadRequestException(
        `Mô tả phải có từ ${ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH} đến ${ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH} ký tự sau khi chuẩn hóa`,
      );
    }
  }

  private assertNoCredentialMaterial(values: string[]): void {
    if (
      values.some((value) =>
        CREDENTIAL_PATTERNS.some((pattern) =>
          pattern.test(this.normalizeCredentialDetectionText(value)),
        ),
      )
    ) {
      throw new BadRequestException(ACCESS_SUPPORT_SENSITIVE_DATA_MESSAGE);
    }
  }

  private normalizeCredentialDetectionText(value: string): string {
    return value
      .normalize('NFKC')
      .replace(/\p{Cf}/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private findDuplicate(requestFingerprint: string) {
    const threshold = new Date(
      Date.now() - ACCESS_SUPPORT_DEDUPE_WINDOW_SECONDS * 1000,
    );
    return this.model
      .findOne({
        source: SystemReportSource.AUTH_PUBLIC,
        requestFingerprintHmac: requestFingerprint,
        createdAt: { $gte: threshold },
      })
      .select('publicId')
      .lean<{ publicId: string }>()
      .exec();
  }

  private response(reportPublicId: string): AccessSupportResponse {
    return Object.freeze({
      reportPublicId,
      message: ACCESS_SUPPORT_ACKNOWLEDGEMENT,
    });
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }
}
