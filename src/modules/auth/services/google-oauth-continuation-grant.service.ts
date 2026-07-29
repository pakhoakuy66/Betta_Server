import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, Types } from 'mongoose';

import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import {
  GOOGLE_OAUTH_CONTINUATION_GRANT_DEFAULT_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_MAX_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_MIN_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH,
  GOOGLE_OAUTH_CONTINUATION_GRANT_TOKEN_BYTES,
} from '../constants/google-oauth-continuation-grant.constants';
import type {
  ConsumedGoogleOAuthLinkGrant,
  ConsumedGoogleOAuthRegistrationGrant,
  IssuedGoogleOAuthContinuationGrant,
  IssueGoogleOAuthLinkGrantInput,
  IssueGoogleOAuthRegistrationGrantInput,
} from '../interfaces/google-oauth-continuation-grant.interface';
import {
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantPurpose,
} from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationGrantRejectedException } from '../exceptions/google-oauth-continuation-grant-rejected.exception';

const RAW_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const SECRET_GRANT_SELECTION = [
  '+providerAccountId',
  '+email',
  '+targetUserId',
  '+fullname',
  '+avatar',
].join(' ');

type StoredGrant = {
  providerAccountId: string;
  email: string;
  targetUserId: Types.ObjectId | null;
  fullname: string | null;
  avatar: string | null;
};

type GrantDocumentInput = {
  purpose: GoogleOAuthContinuationGrantPurpose;
  providerAccountId: string;
  email: string;
  targetUserId: Types.ObjectId | null;
  fullname: string | null;
  avatar: string | null;
};

@Injectable()
export class GoogleOAuthContinuationGrantService {
  private readonly ttlMilliseconds: number;

  constructor(
    @InjectModel(GoogleOAuthContinuationGrant.name)
    private readonly grantModel: Model<GoogleOAuthContinuationGrant>,

    private readonly configService: ConfigService,
  ) {
    this.ttlMilliseconds = this.resolveTtlSeconds() * 1_000;
  }

  issueLinkGrant(
    input: IssueGoogleOAuthLinkGrantInput,
    mongoSession?: ClientSession,
  ): Promise<IssuedGoogleOAuthContinuationGrant> {
    if (!(input.targetUserId instanceof Types.ObjectId)) {
      throw new TypeError('targetUserId must be a MongoDB ObjectId');
    }

    return this.issueGrant(
      {
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        providerAccountId: input.providerAccountId,
        email: this.requireEmail(input.email),
        targetUserId: input.targetUserId,
        fullname: null,
        avatar: null,
      },
      mongoSession,
    );
  }

  issueRegistrationGrant(
    input: IssueGoogleOAuthRegistrationGrantInput,
    mongoSession?: ClientSession,
  ): Promise<IssuedGoogleOAuthContinuationGrant> {
    return this.issueGrant(
      {
        purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
        providerAccountId: input.providerAccountId,
        email: this.requireEmail(input.email),
        targetUserId: null,
        fullname: input.fullname,
        avatar: input.avatar,
      },
      mongoSession,
    );
  }

  async consumeLinkGrant(
    rawGrant: string,
    authenticatedUserId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<ConsumedGoogleOAuthLinkGrant> {
    if (!(authenticatedUserId instanceof Types.ObjectId)) {
      throw new TypeError('authenticatedUserId must be a MongoDB ObjectId');
    }

    this.assertActiveTransaction(mongoSession);

    const grant = await this.consumeGrant(
      rawGrant,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      authenticatedUserId,
      mongoSession,
    );

    /*
     * targetUserId đã nằm trong atomic filter. Kiểm tra này
     * giữ contract nội bộ và fail-closed nếu dữ liệu sai.
     */
    if (
      !grant.targetUserId ||
      !grant.targetUserId.equals(authenticatedUserId)
    ) {
      throw this.invalidGrant();
    }

    return {
      providerAccountId: grant.providerAccountId,
      email: grant.email,
      targetUserId: grant.targetUserId,
    };
  }

  async consumeRegistrationGrant(
    rawGrant: string,
    mongoSession: ClientSession,
  ): Promise<ConsumedGoogleOAuthRegistrationGrant> {
    this.assertActiveTransaction(mongoSession);

    const grant = await this.consumeGrant(
      rawGrant,
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      null,
      mongoSession,
    );

    return {
      providerAccountId: grant.providerAccountId,
      email: grant.email,
      fullname: grant.fullname,
      avatar: grant.avatar,
    };
  }

  private async issueGrant(
    input: GrantDocumentInput,
    mongoSession?: ClientSession,
  ): Promise<IssuedGoogleOAuthContinuationGrant> {
    if (mongoSession) {
      this.assertActiveTransaction(mongoSession);
    }

    /*
     * Không retry bên trong transaction. Duplicate-key có thể
     * khiến transaction hiện tại không còn hợp lệ để tiếp tục.
     */
    const maxAttempts = mongoSession ? 1 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const rawGrant = randomBytes(
        GOOGLE_OAUTH_CONTINUATION_GRANT_TOKEN_BYTES,
      ).toString('base64url');

      const expiresAt = new Date(Date.now() + this.ttlMilliseconds);

      try {
        await this.grantModel.insertMany(
          [
            {
              ...input,
              grantHash: this.hashGrant(rawGrant),
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
          rawGrant,
          expiresAt,
        };
      } catch (error: unknown) {
        const canRetryCollision =
          !mongoSession && attempt === 0 && this.isDuplicateKey(error);

        if (canRetryCollision) {
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unable to allocate Google OAuth continuation grant');
  }

  private async consumeGrant(
    rawGrant: string,
    purpose: GoogleOAuthContinuationGrantPurpose,
    targetUserId: Types.ObjectId | null,
    mongoSession: ClientSession,
  ): Promise<StoredGrant> {
    if (!this.isCanonicalRawGrant(rawGrant)) {
      throw this.invalidGrant();
    }

    const now = new Date();

    const grant = await this.grantModel
      .findOneAndUpdate(
        {
          grantHash: this.hashGrant(rawGrant),
          purpose,
          targetUserId,
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
          session: mongoSession,
        },
      )
      .select(SECRET_GRANT_SELECTION)
      .lean<StoredGrant | null>()
      .exec();

    /*
     * Không phân biệt malformed, expired, replay,
     * wrong-purpose hoặc account mismatch.
     */
    if (!grant) {
      throw this.invalidGrant();
    }

    return grant;
  }

  private assertActiveTransaction(mongoSession: ClientSession): void {
    if (!mongoSession || !mongoSession.inTransaction()) {
      throw new TypeError('An active MongoDB transaction is required');
    }
  }

  private isCanonicalRawGrant(value: string): boolean {
    return (
      typeof value === 'string' &&
      value.length === GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH &&
      RAW_GRANT_PATTERN.test(value)
    );
  }

  private hashGrant(rawGrant: string): string {
    return createHash('sha256').update(rawGrant, 'utf8').digest('base64url');
  }

  private requireEmail(value: string): string {
    const email = normalizeAuthEmail(value);

    if (!email) {
      throw new TypeError('Google OAuth continuation grant requires an email');
    }

    return email;
  }

  private resolveTtlSeconds(): number {
    const rawValue = this.configService.get<string | number>(
      'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS',
    );

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return GOOGLE_OAUTH_CONTINUATION_GRANT_DEFAULT_TTL_SECONDS;
    }

    const value = Number(rawValue);

    if (
      !Number.isInteger(value) ||
      value < GOOGLE_OAUTH_CONTINUATION_GRANT_MIN_TTL_SECONDS ||
      value > GOOGLE_OAUTH_CONTINUATION_GRANT_MAX_TTL_SECONDS
    ) {
      throw new TypeError(
        'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS phải là số nguyên từ 120 đến 900',
      );
    }

    return value;
  }

  private invalidGrant(): GoogleOAuthContinuationGrantRejectedException {
    return new GoogleOAuthContinuationGrantRejectedException();
  }

  private isDuplicateKey(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const code = (error as Record<string, unknown>).code;

    return code === 11000 || code === '11000';
  }
}
