import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHmac } from 'node:crypto';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecretKey,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  ADMIN_LOGIN_IP_LIMIT_MULTIPLIER,
  ADMIN_LOGIN_MINIMUM_IP_LIMIT,
  ADMIN_LOGIN_PROTECTION_KEY_DOMAIN,
  ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE,
  ADMIN_LOGIN_RATE_LIMIT_MESSAGE,
  AdminLoginProtectionScope,
} from '../constants/admin-login-protection.constants';
import { AdminLoginProtection } from '../schemas/admin-login-protection.schema';
import { normalizeAdminTrustedClientIp } from '../utils/get-admin-trusted-client-ip';

export type AdminLoginAttemptIdentity = Readonly<{
  accountKey: string;
  trustedClientIp: string;
}>;

type StoredProtection = Pick<
  AdminLoginProtection,
  | 'scope'
  | 'keyLocators'
  | 'failedAttempts'
  | 'windowStartedAt'
  | 'lockedUntil'
  | 'expiresAt'
> & { _id: Types.ObjectId };

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 11000;

@Injectable()
export class AdminLoginProtectionService {
  constructor(
    @InjectModel(AdminLoginProtection.name)
    private readonly model: Model<AdminLoginProtection>,
    @InjectConnection()
    private readonly connection: Connection,
    @Inject(ADMIN_SECRETS)
    private readonly secrets: AdminSecrets,
    @Inject(ADMIN_POLICY)
    private readonly policy: AdminPolicy,
  ) {}

  async assertAllowed(identity: AdminLoginAttemptIdentity): Promise<void> {
    const locators = this.createIdentityLocators(identity);
    const now = new Date();

    try {
      const [accountRecords, ipRecords] = await Promise.all([
        this.convergeRecords(
          AdminLoginProtectionScope.ACCOUNT,
          locators.account,
          this.policy.loginProtection.maxFailedAttempts,
          now,
        ),
        this.convergeRecords(
          AdminLoginProtectionScope.IP,
          locators.ip,
          this.getIpLimit(),
          now,
        ),
      ]);
      const retryAfterSeconds = Math.max(
        this.readRetryAfter(accountRecords, now),
        this.readRetryAfter(ipRecords, now),
      );

      if (retryAfterSeconds > 0) {
        throw this.rateLimited(retryAfterSeconds);
      }
    } catch (error: unknown) {
      this.rethrowPublicError(error);
    }
  }

  async recordFailure(identity: AdminLoginAttemptIdentity): Promise<void> {
    const locators = this.createIdentityLocators(identity);
    const now = new Date();

    try {
      const [account, ip] = await Promise.all([
        this.increment(
          AdminLoginProtectionScope.ACCOUNT,
          locators.account,
          this.policy.loginProtection.maxFailedAttempts,
          now,
        ),
        this.increment(
          AdminLoginProtectionScope.IP,
          locators.ip,
          this.getIpLimit(),
          now,
        ),
      ]);
      const retryAfterSeconds = Math.max(
        this.readRetryAfter([account], now),
        this.readRetryAfter([ip], now),
      );

      if (retryAfterSeconds > 0) {
        throw this.rateLimited(retryAfterSeconds);
      }
    } catch (error: unknown) {
      this.rethrowPublicError(error);
    }
  }

  async clearAccountFailures(accountKey: string): Promise<void> {
    const locators = this.createProtectionLocators(
      AdminLoginProtectionScope.ACCOUNT,
      this.normalizeAccountKey(accountKey),
    );

    try {
      await this.model.deleteMany(
        this.createFilter(AdminLoginProtectionScope.ACCOUNT, locators),
      );
    } catch (error: unknown) {
      this.rethrowPublicError(error);
    }
  }

  private async increment(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
    limit: number,
    now: Date,
  ): Promise<StoredProtection> {
    await this.convergeRecords(scope, locators, limit, now);
    const windowMs = this.policy.loginProtection.failureWindowSeconds * 1_000;
    const lockMs = this.policy.loginProtection.lockDurationSeconds * 1_000;
    const lockUntilCandidate = new Date(now.getTime() + lockMs);
    const epoch = new Date(0);
    const pipeline = [
      {
        $set: {
          scope: { $ifNull: ['$scope', scope] },
          keyLocators: {
            $setUnion: [
              {
                $cond: [{ $isArray: '$keyLocators' }, '$keyLocators', []],
              },
              { $literal: locators },
            ],
          },
          __activeLock: {
            $gt: [{ $ifNull: ['$lockedUntil', epoch] }, now],
          },
          __hasLock: {
            $ne: [{ $ifNull: ['$lockedUntil', null] }, null],
          },
          __windowActive: {
            $gt: [
              {
                $add: [{ $ifNull: ['$windowStartedAt', epoch] }, windowMs],
              },
              now,
            ],
          },
        },
      },
      {
        $set: {
          __continueWindow: {
            $and: [
              { $eq: ['$__activeLock', false] },
              { $eq: ['$__hasLock', false] },
              '$__windowActive',
            ],
          },
        },
      },
      {
        $set: {
          __nextAttempts: {
            $cond: [
              '$__activeLock',
              { $ifNull: ['$failedAttempts', 0] },
              {
                $cond: [
                  '$__continueWindow',
                  { $add: [{ $ifNull: ['$failedAttempts', 0] }, 1] },
                  1,
                ],
              },
            ],
          },
          __nextWindowStartedAt: {
            $cond: [
              '$__activeLock',
              '$windowStartedAt',
              { $cond: ['$__continueWindow', '$windowStartedAt', now] },
            ],
          },
        },
      },
      {
        $set: {
          __nextLockedUntil: {
            $cond: [
              '$__activeLock',
              '$lockedUntil',
              {
                $cond: [
                  { $gte: ['$__nextAttempts', limit] },
                  lockUntilCandidate,
                  null,
                ],
              },
            ],
          },
        },
      },
      {
        $set: {
          failedAttempts: '$__nextAttempts',
          windowStartedAt: '$__nextWindowStartedAt',
          lockedUntil: '$__nextLockedUntil',
          expiresAt: {
            $cond: [
              '$__activeLock',
              '$expiresAt',
              {
                $max: [
                  { $add: ['$__nextWindowStartedAt', windowMs] },
                  { $ifNull: ['$__nextLockedUntil', epoch] },
                ],
              },
            ],
          },
        },
      },
      {
        $unset: [
          '__activeLock',
          '__hasLock',
          '__windowActive',
          '__continueWindow',
          '__nextAttempts',
          '__nextWindowStartedAt',
          '__nextLockedUntil',
        ],
      },
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.executeIncrement(scope, locators, pipeline);
      } catch (error: unknown) {
        if (!isDuplicateKeyError(error)) throw error;
        await this.convergeRecords(scope, locators, limit, now);
      }
    }

    throw new ServiceUnavailableException(
      ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE,
    );
  }

  private async executeIncrement(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
    pipeline: readonly Record<string, unknown>[],
  ): Promise<StoredProtection> {
    const record = await this.model
      .findOneAndUpdate(this.createFilter(scope, locators), pipeline, {
        returnDocument: 'after',
        updatePipeline: true,
        upsert: true,
      })
      .lean<StoredProtection | null>()
      .exec();

    if (!record) {
      throw new ServiceUnavailableException(
        ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE,
      );
    }
    return record;
  }

  private async convergeRecords(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
    limit: number,
    now: Date,
  ): Promise<StoredProtection[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const records = await this.findRecords(scope, locators);
      if (records.length === 0) return [];

      if (records.length === 1) {
        try {
          await this.attachLocators(records[0]._id, locators);
          records[0].keyLocators = this.unionLocators(
            records[0].keyLocators,
            locators,
          );
          return records.filter((record) =>
            this.isLogicallyRelevant(record, now),
          );
        } catch (error: unknown) {
          if (!isDuplicateKeyError(error)) throw error;
          continue;
        }
      }

      await this.collapseSplitRecords(scope, locators, limit, now);
    }

    throw new ServiceUnavailableException(
      ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE,
    );
  }

  private async collapseSplitRecords(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
    limit: number,
    now: Date,
  ): Promise<void> {
    await this.connection.transaction(async (session) => {
      const records = await this.findRecords(scope, locators, session);
      if (records.length <= 1) return;

      const ordered = [...records].sort((left, right) =>
        left._id.toHexString().localeCompare(right._id.toHexString()),
      );
      const canonical = ordered[0];
      const stale = ordered.slice(1);
      const merged = this.mergeRecords(scope, records, locators, limit, now);

      if (!merged) {
        await this.model.deleteMany(
          { _id: { $in: ordered.map((record) => record._id) } },
          { session },
        );
        return;
      }

      merged.keyLocators = [...canonical.keyLocators];
      await this.model.updateOne(
        { _id: canonical._id },
        { $set: merged },
        { session },
      );
      await this.model.deleteMany(
        { _id: { $in: stale.map((record) => record._id) } },
        { session },
      );
    });
  }

  private findRecords(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
    session?: ClientSession,
  ): Promise<StoredProtection[]> {
    const query = this.model
      .find(this.createFilter(scope, locators))
      .select(
        'scope keyLocators failedAttempts windowStartedAt lockedUntil expiresAt',
      )
      .limit(locators.length);

    if (session) query.session(session);
    return query.lean<StoredProtection[]>().exec();
  }

  private attachLocators(
    id: Types.ObjectId,
    locators: readonly string[],
    session?: ClientSession,
  ): Promise<unknown> {
    return this.model.updateOne(
      { _id: id },
      { $addToSet: { keyLocators: { $each: locators } } },
      session ? { session } : undefined,
    );
  }

  private mergeRecords(
    scope: AdminLoginProtectionScope,
    records: readonly StoredProtection[],
    locators: readonly string[],
    limit: number,
    now: Date,
  ): Omit<StoredProtection, '_id'> | null {
    const activeLocks = records.filter((record) =>
      this.hasActiveLock(record, now),
    );
    const activeWindows = records.filter(
      (record) =>
        !record.lockedUntil &&
        record.windowStartedAt.getTime() +
          this.policy.loginProtection.failureWindowSeconds * 1_000 >
          now.getTime(),
    );
    const keyLocators = this.unionLocators(
      records.flatMap((record) => record.keyLocators),
      locators,
    );

    if (activeLocks.length > 0) {
      const lockedUntil = this.maxDate(
        activeLocks
          .map((record) => record.lockedUntil)
          .filter((value): value is Date => value instanceof Date),
      );
      const windowStartedAt = this.minDate(
        activeLocks.map((record) => record.windowStartedAt),
      );

      return {
        scope,
        keyLocators,
        failedAttempts: Math.max(
          ...activeLocks.map((record) => record.failedAttempts),
        ),
        windowStartedAt,
        lockedUntil,
        expiresAt: this.maxDate([
          this.addMilliseconds(
            windowStartedAt,
            this.policy.loginProtection.failureWindowSeconds * 1_000,
          ),
          lockedUntil,
        ]),
      };
    }

    if (activeWindows.length === 0) return null;

    const failedAttempts = Math.min(
      limit,
      activeWindows.reduce((total, record) => total + record.failedAttempts, 0),
    );
    const windowStartedAt = this.minDate(
      activeWindows.map((record) => record.windowStartedAt),
    );
    const lockedUntil =
      failedAttempts >= limit
        ? this.addMilliseconds(
            now,
            this.policy.loginProtection.lockDurationSeconds * 1_000,
          )
        : null;

    return {
      scope,
      keyLocators,
      failedAttempts,
      windowStartedAt,
      lockedUntil,
      expiresAt: this.maxDate([
        this.addMilliseconds(
          windowStartedAt,
          this.policy.loginProtection.failureWindowSeconds * 1_000,
        ),
        lockedUntil ?? new Date(0),
      ]),
    };
  }

  private createIdentityLocators(
    identity: AdminLoginAttemptIdentity,
  ): Readonly<{
    account: readonly string[];
    ip: readonly string[];
  }> {
    const account = this.normalizeAccountKey(identity.accountKey);
    const ip = normalizeAdminTrustedClientIp(identity.trustedClientIp);

    return Object.freeze({
      account: this.createProtectionLocators(
        AdminLoginProtectionScope.ACCOUNT,
        account,
      ),
      ip: this.createProtectionLocators(AdminLoginProtectionScope.IP, ip),
    });
  }

  private createProtectionLocators(
    scope: AdminLoginProtectionScope,
    normalizedIdentity: string,
  ): readonly string[] {
    return Object.freeze(
      this.secrets
        .candidates(AdminSecretPurpose.CONTACT_LOOKUP_HMAC)
        .map((key) => this.hashIdentity(scope, normalizedIdentity, key)),
    );
  }

  private hashIdentity(
    scope: AdminLoginProtectionScope,
    identity: string,
    secret: AdminSecretKey,
  ): string {
    const digest = createHmac('sha256', secret.key)
      .update(ADMIN_LOGIN_PROTECTION_KEY_DOMAIN)
      .update('\0')
      .update(scope)
      .update('\0')
      .update(identity)
      .digest('hex');

    return `${secret.id}:${digest}`;
  }

  private createFilter(
    scope: AdminLoginProtectionScope,
    locators: readonly string[],
  ): Readonly<Record<string, unknown>> {
    return { scope, keyLocators: { $in: locators } };
  }

  private unionLocators(
    left: readonly string[],
    right: readonly string[],
  ): string[] {
    return [...new Set([...left, ...right])];
  }

  private normalizeAccountKey(value: unknown): string {
    const normalized = normalizeAuthEmail(value);
    if (normalized.length === 0 || normalized.length > 254) {
      throw new TypeError('Admin login account key không hợp lệ');
    }
    return normalized;
  }

  private readRetryAfter(
    records: readonly Pick<AdminLoginProtection, 'lockedUntil'>[],
    now: Date,
  ): number {
    return records.reduce((maximum, record) => {
      const lockedUntil = record.lockedUntil?.getTime() ?? 0;
      const remaining = Math.ceil((lockedUntil - now.getTime()) / 1_000);
      return Math.max(maximum, remaining);
    }, 0);
  }

  private getIpLimit(): number {
    return Math.max(
      ADMIN_LOGIN_MINIMUM_IP_LIMIT,
      this.policy.loginProtection.maxFailedAttempts *
        ADMIN_LOGIN_IP_LIMIT_MULTIPLIER,
    );
  }

  private isLogicallyRelevant(
    record: Pick<AdminLoginProtection, 'windowStartedAt' | 'lockedUntil'>,
    now: Date,
  ): boolean {
    return (
      this.hasActiveLock(record, now) ||
      (!record.lockedUntil &&
        record.windowStartedAt.getTime() +
          this.policy.loginProtection.failureWindowSeconds * 1_000 >
          now.getTime())
    );
  }

  private hasActiveLock(
    record: Pick<AdminLoginProtection, 'lockedUntil'>,
    now: Date,
  ): boolean {
    return (record.lockedUntil?.getTime() ?? 0) > now.getTime();
  }

  private minDate(values: readonly Date[]): Date {
    return new Date(Math.min(...values.map((value) => value.getTime())));
  }

  private maxDate(values: readonly Date[]): Date {
    return new Date(Math.max(...values.map((value) => value.getTime())));
  }

  private addMilliseconds(value: Date, milliseconds: number): Date {
    return new Date(value.getTime() + milliseconds);
  }

  private rateLimited(retryAfterSeconds: number): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: ADMIN_LOGIN_RATE_LIMIT_MESSAGE,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private rethrowPublicError(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        ADMIN_LOGIN_PROTECTION_UNAVAILABLE_MESSAGE,
      );
    }
    throw error;
  }
}
