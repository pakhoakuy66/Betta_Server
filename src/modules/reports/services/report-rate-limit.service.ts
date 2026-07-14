import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { Model, Types, type UpdateQuery } from 'mongoose';
import { ReportRateLimit } from '../schemas/report-rate-limit.schema';
import { ReportRateLimitException } from '../exceptions/report-rate-limit.exception';

type RateLimitKind = 'content_report' | 'system_report' | 'system_upload';

type RateLimitPolicy = {
  windowSeconds: number;
  userLimit: number;
  ipLimit: number;
  distinctTargetLimit?: number;
};

type FixedWindow = {
  bucket: number;
  start: Date;
  end: Date;
  expiresAt: Date;
};

type CounterResult = {
  count: number;
  targetKeys?: string[];
};

type ConsumeOptions = {
  kind: RateLimitKind;
  reporterId: Types.ObjectId;
  clientIp?: string;
  targetKey?: string;
  message: string;
};

type IncrementOptions = {
  scope: string;
  discriminator: string;
  reporterId?: Types.ObjectId;
  ipHash?: string;
  targetKey?: string;
  window: FixedWindow;
};

const UPSERT_RETRIES = 2;

@Injectable()
export class ReportRateLimitService {
  private readonly logger = new Logger(ReportRateLimitService.name);
  private readonly secret: string;
  private readonly ttlBufferSeconds: number;
  private readonly policies: Record<RateLimitKind, RateLimitPolicy>;
  private warnedInvalidIp = false;

  constructor(
    @InjectModel(ReportRateLimit.name)
    private readonly model: Model<ReportRateLimit>,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('REPORT_RATE_LIMIT_HASH_SECRET') ?? '';

    const invalidSecrets = new Set([
      'replace_with_random_secret_minimum_32_characters',
      'your_report_rate_limit_secret',
    ]);

    if (this.secret.length < 32 || invalidSecrets.has(this.secret)) {
      throw new Error(
        'REPORT_RATE_LIMIT_HASH_SECRET chưa được cấu hình an toàn',
      );
    }

    this.ttlBufferSeconds = this.readPositiveInteger(
      config,
      'REPORT_RATE_LIMIT_TTL_BUFFER_SECONDS',
      60,
    );

    this.policies = {
      content_report: {
        windowSeconds: this.readPositiveInteger(
          config,
          'REPORT_CONTENT_WINDOW_SECONDS',
          600,
        ),
        userLimit: this.readPositiveInteger(
          config,
          'REPORT_CONTENT_USER_LIMIT',
          10,
        ),
        ipLimit: this.readPositiveInteger(
          config,
          'REPORT_CONTENT_IP_LIMIT',
          40,
        ),
        distinctTargetLimit: this.readPositiveInteger(
          config,
          'REPORT_CONTENT_DISTINCT_TARGET_LIMIT',
          8,
        ),
      },
      system_report: {
        windowSeconds: this.readPositiveInteger(
          config,
          'REPORT_SYSTEM_WINDOW_SECONDS',
          600,
        ),
        userLimit: this.readPositiveInteger(
          config,
          'REPORT_SYSTEM_USER_LIMIT',
          5,
        ),
        ipLimit: this.readPositiveInteger(config, 'REPORT_SYSTEM_IP_LIMIT', 20),
        distinctTargetLimit: this.readPositiveInteger(
          config,
          'REPORT_SYSTEM_DISTINCT_TARGET_LIMIT',
          3,
        ),
      },
      system_upload: {
        windowSeconds: this.readPositiveInteger(
          config,
          'REPORT_UPLOAD_WINDOW_SECONDS',
          600,
        ),
        userLimit: this.readPositiveInteger(
          config,
          'REPORT_UPLOAD_USER_LIMIT',
          5,
        ),
        ipLimit: this.readPositiveInteger(config, 'REPORT_UPLOAD_IP_LIMIT', 20),
      },
    };
    for (const [name, policy] of Object.entries(this.policies)) {
      this.validatePolicy(name, policy);
    }
  }

  private validatePolicy(name: string, policy: RateLimitPolicy): void {
    const maximumWindowSeconds = 24 * 60 * 60;

    if (policy.windowSeconds > maximumWindowSeconds) {
      throw new Error(`${name}: windowSeconds không được vượt quá 86400 giây`);
    }

    if (policy.ipLimit < policy.userLimit) {
      throw new Error(`${name}: ipLimit không được nhỏ hơn userLimit`);
    }

    if (
      policy.distinctTargetLimit !== undefined &&
      policy.distinctTargetLimit > policy.userLimit
    ) {
      throw new Error(
        `${name}: distinctTargetLimit không được lớn hơn userLimit`,
      );
    }
  }

  consumeContentReport(options: {
    reporterId: Types.ObjectId;
    clientIp?: string;
    targetType: 'POST' | 'USER';
    targetId: Types.ObjectId;
  }): Promise<void> {
    return this.consume({
      kind: 'content_report',
      reporterId: options.reporterId,
      clientIp: options.clientIp,
      targetKey: `${options.targetType}:${options.targetId.toString()}`,
      message: 'Bạn đã gửi quá nhiều báo cáo. Vui lòng thử lại sau.',
    });
  }

  consumeSystemReport(options: {
    reporterId: Types.ObjectId;
    clientIp?: string;
    descriptionHash: string;
  }): Promise<void> {
    return this.consume({
      kind: 'system_report',
      reporterId: options.reporterId,
      clientIp: options.clientIp,
      targetKey: `DESCRIPTION:${options.descriptionHash}`,
      message: 'Bạn đã gửi quá nhiều báo cáo sự cố. Vui lòng thử lại sau.',
    });
  }

  consumeSystemUpload(options: {
    reporterId: Types.ObjectId;
    clientIp?: string;
  }): Promise<void> {
    return this.consume({
      kind: 'system_upload',
      reporterId: options.reporterId,
      clientIp: options.clientIp,
      message:
        'Bạn đã gửi quá nhiều yêu cầu báo cáo sự cố. Vui lòng thử lại sau.',
    });
  }

  private async consume(options: ConsumeOptions): Promise<void> {
    const policy = this.policies[options.kind];
    const window = this.getFixedWindow(policy.windowSeconds);
    const userDiscriminator = options.reporterId.toString();

    // User quota luôn được kiểm trước để một account xấu
    // không thể đầu độc IP quota dùng chung.
    await this.hitAndAssert({
      increment: {
        scope: `${options.kind}:user`,
        discriminator: userDiscriminator,
        reporterId: options.reporterId,
        window,
      },
      limit: policy.userLimit,
      message: options.message,
      window,
    });

    const ipHash = this.hashClientIp(options.clientIp);

    if (ipHash) {
      await this.hitAndAssert({
        increment: {
          scope: `${options.kind}:ip`,
          discriminator: ipHash,
          ipHash,
          window,
        },
        limit: policy.ipLimit,
        message: options.message,
        window,
      });
    }

    if (options.targetKey && policy.distinctTargetLimit !== undefined) {
      await this.hitAndAssert({
        increment: {
          scope: `${options.kind}:targets`,
          discriminator: userDiscriminator,
          reporterId: options.reporterId,
          targetKey: this.hmac(`target:${options.targetKey}`),
          window,
        },
        limit: policy.distinctTargetLimit,
        message: options.message,
        window,
        useDistinctTargets: true,
      });
    }
  }

  private async hitAndAssert(options: {
    increment: IncrementOptions;
    limit: number;
    message: string;
    window: FixedWindow;
    useDistinctTargets?: boolean;
  }): Promise<void> {
    const counter = await this.incrementCounter(options.increment);

    const observed = options.useDistinctTargets
      ? (counter.targetKeys?.length ?? 0)
      : counter.count;

    if (observed <= options.limit) {
      return;
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((options.window.end.getTime() - Date.now()) / 1000),
    );

    // Chỉ log lần đầu vượt giới hạn, tránh bot gây log flooding.
    if (observed === options.limit + 1) {
      const safeKey = this.buildCounterKey(options.increment).slice(0, 12);

      this.logger.warn(
        `Report rate limit reached scope=${options.increment.scope} ` +
          `key=${safeKey} retryAfterSeconds=${retryAfterSeconds}`,
      );
    }

    throw new ReportRateLimitException(options.message, retryAfterSeconds);
  }

  private async incrementCounter(
    options: IncrementOptions,
  ): Promise<CounterResult> {
    const key = this.buildCounterKey(options);
    const update = this.buildIncrementUpdate(options);

    for (let attempt = 0; attempt <= UPSERT_RETRIES; attempt += 1) {
      try {
        const counter = await this.model
          .findOneAndUpdate({ key }, update, {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
          })
          .select('count targetKeys')
          .lean<CounterResult>()
          .exec();

        if (counter) {
          return counter;
        }
      } catch (error: unknown) {
        if (!this.isDuplicateKeyError(error)) {
          throw error;
        }

        const counter = await this.model
          .findOneAndUpdate({ key }, this.buildExistingCounterUpdate(options), {
            returnDocument: 'after',
          })
          .select('count targetKeys')
          .lean<CounterResult>()
          .exec();

        if (counter) {
          return counter;
        }
      }
    }

    throw new ServiceUnavailableException(
      'Không thể kiểm tra giới hạn báo cáo',
    );
  }

  private buildIncrementUpdate(
    options: IncrementOptions,
  ): UpdateQuery<ReportRateLimit> {
    const update: UpdateQuery<ReportRateLimit> = {
      $inc: { count: 1 },
      $setOnInsert: {
        key: this.buildCounterKey(options),
        scope: options.scope,
        userId: options.reporterId ?? null,
        ipHash: options.ipHash ?? null,
        windowStart: options.window.start,
        windowEnd: options.window.end,
        expiresAt: options.window.expiresAt,
      },
    };

    if (options.targetKey) {
      update.$addToSet = {
        targetKeys: options.targetKey,
      };
    }

    return update;
  }

  private buildExistingCounterUpdate(
    options: IncrementOptions,
  ): UpdateQuery<ReportRateLimit> {
    const update: UpdateQuery<ReportRateLimit> = {
      $inc: { count: 1 },
    };

    if (options.targetKey) {
      update.$addToSet = {
        targetKeys: options.targetKey,
      };
    }

    return update;
  }

  private buildCounterKey(options: IncrementOptions): string {
    return this.hmac(
      [
        'report-rate-limit',
        options.scope,
        options.discriminator,
        options.window.bucket,
      ].join(':'),
    );
  }

  private getFixedWindow(windowSeconds: number): FixedWindow {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const bucket = Math.floor(now / windowMs);
    const startMs = bucket * windowMs;
    const endMs = startMs + windowMs;

    return {
      bucket,
      start: new Date(startMs),
      end: new Date(endMs),
      expiresAt: new Date(endMs + this.ttlBufferSeconds * 1000),
    };
  }

  private hashClientIp(clientIp?: string): string | null {
    const normalizedIp = this.normalizeIp(clientIp);

    if (!normalizedIp) {
      if (!this.warnedInvalidIp) {
        this.warnedInvalidIp = true;
        this.logger.warn(
          'Không xác định được IP tin cậy cho report limiter; ' +
            'hệ thống chỉ áp dụng giới hạn theo user.',
        );
      }

      return null;
    }

    return this.hmac(`ip:${normalizedIp}`);
  }

  private normalizeIp(clientIp?: string): string | null {
    if (!clientIp) {
      return null;
    }

    let value = clientIp.trim();

    if (value.startsWith('::ffff:')) {
      value = value.slice(7);
    }

    const zoneIndex = value.indexOf('%');

    if (zoneIndex >= 0) {
      value = value.slice(0, zoneIndex);
    }

    return isIP(value) > 0 ? value.toLowerCase() : null;
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  private readPositiveInteger(
    config: ConfigService,
    key: string,
    fallback: number,
  ): number {
    const value = Number(config.get<string>(key) ?? fallback);

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} phải là số nguyên dương`);
    }

    return value;
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
