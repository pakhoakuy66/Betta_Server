import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac } from 'crypto';
import { Model } from 'mongoose';
import { AuthRateLimit } from '../schemas/auth-rate-limit.schema';

type Action = 'login' | 'forgot' | 'otp';
type Policy = {
  ipLimit: number;
  accountLimit: number;
  windowSeconds: number;
};

@Injectable()
export class AuthRateLimitService {
  private readonly secret: string;
  private readonly policies: Record<Action, Policy>;

  constructor(
    @InjectModel(AuthRateLimit.name)
    private readonly model: Model<AuthRateLimit>,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('AUTH_RATE_LIMIT_SECRET') ?? '';

    const invalidSecrets = new Set([
      'replace_with_random_secret_minimum_32_characters',
      'thay_bang_secret_ngau_nhien',
    ]);

    if (this.secret.length < 32 || invalidSecrets.has(this.secret)) {
      throw new Error('AUTH_RATE_LIMIT_SECRET chưa được cấu hình an toàn');
    }

    this.policies = {
      login: {
        ipLimit: this.readNumber(config, 'AUTH_LOGIN_IP_LIMIT', 20),
        accountLimit: this.readNumber(config, 'AUTH_LOGIN_ACCOUNT_LIMIT', 10),
        windowSeconds: this.readNumber(
          config,
          'AUTH_LOGIN_WINDOW_SECONDS',
          900,
        ),
      },
      forgot: {
        ipLimit: this.readNumber(config, 'AUTH_FORGOT_IP_LIMIT', 5),
        accountLimit: this.readNumber(config, 'AUTH_FORGOT_ACCOUNT_LIMIT', 3),
        windowSeconds: this.readNumber(
          config,
          'AUTH_FORGOT_WINDOW_SECONDS',
          900,
        ),
      },
      otp: {
        ipLimit: this.readNumber(config, 'AUTH_OTP_IP_LIMIT', 20),
        accountLimit: this.readNumber(config, 'AUTH_OTP_ACCOUNT_LIMIT', 8),
        windowSeconds: this.readNumber(config, 'AUTH_OTP_WINDOW_SECONDS', 600),
      },
    };
  }

  async consume(action: Action, ip: string, account: string): Promise<void> {
    const policy = this.policies[action];
    const normalizedAccount = account.trim().toLowerCase();

    await Promise.all([
      this.hit(`${action}:ip:${this.normalizeIp(ip)}`, policy.ipLimit, policy),
      this.hit(
        `${action}:account:${normalizedAccount}`,
        policy.accountLimit,
        policy,
      ),
    ]);
  }

  private async hit(
    identity: string,
    limit: number,
    policy: Policy,
  ): Promise<void> {
    const now = Date.now();
    const windowMs = policy.windowSeconds * 1000;
    const bucket = Math.floor(now / windowMs);
    const windowEnd = (bucket + 1) * windowMs;

    const keyHash = createHmac('sha256', this.secret)
      .update(`${identity}:${bucket}`)
      .digest('hex');

    let record: AuthRateLimit | null;

    try {
      record = await this.model.findOneAndUpdate(
        { keyHash },
        {
          $inc: { count: 1 },
          $setOnInsert: {
            expiresAt: new Date(windowEnd),
          },
        },
        { upsert: true, new: true },
      );
    } catch (error: unknown) {
      const duplicate =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000;

      if (!duplicate) throw error;

      record = await this.model.findOneAndUpdate(
        { keyHash },
        { $inc: { count: 1 } },
        { new: true },
      );
    }

    if (!record) {
      throw new ServiceUnavailableException(
        'Không thể kiểm tra giới hạn yêu cầu',
      );
    }

    if (record.count > limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((windowEnd - Date.now()) / 1000),
          ),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private normalizeIp(ip: string): string {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  private readNumber(
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
}
