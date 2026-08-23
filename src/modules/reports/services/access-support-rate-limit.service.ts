import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'crypto';
import { isIP } from 'net';
import { Model } from 'mongoose';
import {
  ACCESS_SUPPORT_CHALLENGE_DIFFICULTY_BITS,
  ACCESS_SUPPORT_CHALLENGE_FROM_REQUEST,
  ACCESS_SUPPORT_CHALLENGE_TTL_SECONDS,
  ACCESS_SUPPORT_CONTACT_LIMIT,
  ACCESS_SUPPORT_CONTACT_WINDOW_SECONDS,
  ACCESS_SUPPORT_IP_LIMIT,
  ACCESS_SUPPORT_IP_WINDOW_SECONDS,
  ACCESS_SUPPORT_RATE_LIMIT_TTL_BUFFER_SECONDS,
} from '../constants/access-support.constants';
import { AccessSupportChallengeRequiredException } from '../exceptions/access-support-challenge-required.exception';
import { ReportRateLimit } from '../schemas/report-rate-limit.schema';
import { AccessSupportCryptoService } from './access-support-crypto.service';

type Counter = { count: number };
const COUNTER_UPSERT_RETRIES = 2;

@Injectable()
export class AccessSupportRateLimitService {
  constructor(
    @InjectModel(ReportRateLimit.name)
    private readonly model: Model<ReportRateLimit>,
    private readonly crypto: AccessSupportCryptoService,
  ) {}

  async consumeIp(
    clientIp: string | undefined,
    fingerprint: string,
    challengeHeader?: string,
  ): Promise<void> {
    const normalizedIp = this.normalizeIp(clientIp);
    if (!normalizedIp) {
      throw this.tooManyRequests('Không thể xác minh nguồn yêu cầu');
    }

    const ipHash = this.crypto.hmac('ip', normalizedIp);
    const counter = await this.increment(
      'access_support:ip',
      ipHash,
      ACCESS_SUPPORT_IP_WINDOW_SECONDS,
    );
    if (counter.count > ACCESS_SUPPORT_IP_LIMIT) {
      throw this.tooManyRequests('Đã gửi quá nhiều yêu cầu hỗ trợ');
    }

    if (counter.count >= ACCESS_SUPPORT_CHALLENGE_FROM_REQUEST) {
      if (!this.verifyChallenge(challengeHeader, ipHash, fingerprint)) {
        throw new AccessSupportChallengeRequiredException(
          this.createChallenge(ipHash, fingerprint),
        );
      }
    }
  }

  async consumeContact(contactLookupHmac: string): Promise<void> {
    const counter = await this.increment(
      'access_support:contact',
      contactLookupHmac,
      ACCESS_SUPPORT_CONTACT_WINDOW_SECONDS,
    );
    if (counter.count > ACCESS_SUPPORT_CONTACT_LIMIT) {
      throw this.tooManyRequests('Đã gửi quá nhiều yêu cầu hỗ trợ');
    }
  }

  private createChallenge(ipHash: string, fingerprint: string) {
    const expiresAt = Date.now() + ACCESS_SUPPORT_CHALLENGE_TTL_SECONDS * 1000;
    const payload = JSON.stringify({
      i: ipHash,
      f: fingerprint,
      e: expiresAt,
      n: randomBytes(12).toString('base64url'),
    });
    return Object.freeze({
      token: this.crypto.signChallenge(payload),
      difficultyBits: ACCESS_SUPPORT_CHALLENGE_DIFFICULTY_BITS,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private verifyChallenge(
    header: string | undefined,
    ipHash: string,
    fingerprint: string,
  ): boolean {
    if (!header || header.length > 4096) return false;
    const separator = header.lastIndexOf('.');
    if (separator <= 0) return false;
    const token = header.slice(0, separator);
    const solution = header.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(solution)) return false;

    const raw = this.crypto.verifyChallengeToken(token);
    if (!raw) return false;
    try {
      const payload = JSON.parse(raw) as {
        i?: unknown;
        f?: unknown;
        e?: unknown;
      };
      if (
        payload.i !== ipHash ||
        payload.f !== fingerprint ||
        typeof payload.e !== 'number' ||
        payload.e < Date.now()
      ) {
        return false;
      }
    } catch {
      return false;
    }

    const digest = createHash('sha256').update(`${token}:${solution}`).digest();
    return this.hasLeadingZeroBits(
      digest,
      ACCESS_SUPPORT_CHALLENGE_DIFFICULTY_BITS,
    );
  }

  private hasLeadingZeroBits(value: Buffer, bits: number): boolean {
    const bytes = Math.floor(bits / 8);
    const remainder = bits % 8;
    for (let index = 0; index < bytes; index += 1) {
      if (value[index] !== 0) return false;
    }
    return remainder === 0 || value[bytes] >> (8 - remainder) === 0;
  }

  private async increment(
    scope: string,
    discriminator: string,
    windowSeconds: number,
  ): Promise<Counter> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const bucket = Math.floor(now / windowMs);
    const windowStart = new Date(bucket * windowMs);
    const windowEnd = new Date(windowStart.getTime() + windowMs);
    const key = this.crypto.hmac(
      'rate-limit',
      `${scope}:${discriminator}:${bucket}`,
    );

    const insertUpdate = {
      $inc: { count: 1 },
      $setOnInsert: {
        key,
        scope,
        windowStart,
        windowEnd,
        expiresAt: new Date(
          windowEnd.getTime() +
            ACCESS_SUPPORT_RATE_LIMIT_TTL_BUFFER_SECONDS * 1000,
        ),
      },
    };

    for (let attempt = 0; attempt <= COUNTER_UPSERT_RETRIES; attempt += 1) {
      try {
        const counter = await this.model
          .findOneAndUpdate({ key }, insertUpdate, {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
          })
          .select('count')
          .lean<Counter>()
          .exec();
        if (counter) return counter;
      } catch (error: unknown) {
        if (!this.isDuplicateKeyError(error)) throw error;
        const counter = await this.model
          .findOneAndUpdate(
            { key },
            { $inc: { count: 1 } },
            { returnDocument: 'after' },
          )
          .select('count')
          .lean<Counter>()
          .exec();
        if (counter) return counter;
      }
    }

    throw this.tooManyRequests('Không thể xác minh yêu cầu');
  }

  private normalizeIp(value?: string): string | null {
    if (!value) return null;
    let normalized = value.trim();
    if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);
    const zoneIndex = normalized.indexOf('%');
    if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
    return isIP(normalized) > 0 ? normalized.toLowerCase() : null;
  }

  private tooManyRequests(message: string): HttpException {
    return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
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
