import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ACCESS_SUPPORT_DEDUPE_TTL_BUFFER_SECONDS,
  ACCESS_SUPPORT_DEDUPE_WINDOW_SECONDS,
} from '../constants/access-support.constants';
import { AccessSupportDedupe } from '../schemas/access-support-dedupe.schema';
import { generateSystemReportPublicId } from '../utils/generate-system-report-public-id';

export type AccessSupportDedupeClaim = Readonly<{ reportPublicId: string }>;
type StoredClaim = { reportPublicId: string; activeUntil: Date };
const CLAIM_RETRIES = 4;

@Injectable()
export class AccessSupportDedupeService {
  constructor(
    @InjectModel(AccessSupportDedupe.name)
    private readonly model: Model<AccessSupportDedupe>,
  ) {}

  async claim(
    fingerprintHmac: string,
    now = new Date(),
  ): Promise<AccessSupportDedupeClaim> {
    const candidateReportPublicId = generateSystemReportPublicId();
    const activeUntil = new Date(
      now.getTime() + ACCESS_SUPPORT_DEDUPE_WINDOW_SECONDS * 1_000,
    );
    const expiresAt = new Date(
      activeUntil.getTime() + ACCESS_SUPPORT_DEDUPE_TTL_BUFFER_SECONDS * 1_000,
    );

    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt += 1) {
      try {
        const created = await this.model.create({
          fingerprintHmac,
          reportPublicId: candidateReportPublicId,
          activeUntil,
          expiresAt,
        });
        return Object.freeze({ reportPublicId: created.reportPublicId });
      } catch (error: unknown) {
        if (!this.isDuplicateKeyError(error)) throw error;
      }

      const existing = await this.model
        .findOne({ fingerprintHmac })
        .select('+fingerprintHmac reportPublicId activeUntil')
        .lean<StoredClaim>()
        .exec();
      if (!existing) continue;
      if (existing.activeUntil.getTime() > now.getTime()) {
        return Object.freeze({ reportPublicId: existing.reportPublicId });
      }

      const renewed = await this.model
        .findOneAndUpdate(
          {
            fingerprintHmac,
            reportPublicId: existing.reportPublicId,
            activeUntil: existing.activeUntil,
          },
          {
            $set: {
              reportPublicId: candidateReportPublicId,
              activeUntil,
              expiresAt,
            },
          },
          { returnDocument: 'after' },
        )
        .select('reportPublicId')
        .lean<{ reportPublicId: string }>()
        .exec();
      if (renewed) {
        return Object.freeze({ reportPublicId: renewed.reportPublicId });
      }
    }

    throw new ServiceUnavailableException(
      'Không thể ghi nhận yêu cầu hỗ trợ vào lúc này',
    );
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
