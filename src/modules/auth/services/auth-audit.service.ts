import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  AuthAuditEventCode,
  type AuthAuditMetadata,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
  type RecordAuthAuditInput,
} from '../interfaces/auth-audit.interface';
import {
  AUTH_AUDIT_DEFAULT_RETENTION_DAYS,
  AUTH_AUDIT_SESSION_ID_PATTERN,
  AuthAuditEvent,
} from '../schemas/auth-audit-event.schema';

const DAY_IN_MILLISECONDS = 86_400_000;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 730;

const ALLOWED_METADATA_KEYS = new Set<keyof AuthAuditMetadata>([
  'affectedSessionCount',
  'provider',
]);

type AuthAuditSessionPolicy = 'required' | 'forbidden';

type AuthAuditPolicy = {
  outcome: AuthAuditOutcome;
  reasonCode: AuthAuditReasonCode;
  sessionPolicy: AuthAuditSessionPolicy;
  allowsAffectedSessionCount: boolean;
  requiresProvider: boolean;
};

const AUTH_AUDIT_POLICIES: Readonly<
  Record<AuthAuditEventCode, AuthAuditPolicy>
> = {
  [AuthAuditEventCode.ACCOUNT_LOCKED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.LOGIN_FAILURE_THRESHOLD,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: false,
    requiresProvider: false,
  },
  [AuthAuditEventCode.PASSWORD_CHANGED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: true,
    requiresProvider: false,
  },
  [AuthAuditEventCode.PASSWORD_RESET]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.PASSWORD_RESET_COMPLETED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: true,
    requiresProvider: false,
  },
  [AuthAuditEventCode.SESSION_REVOKED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
    sessionPolicy: 'required',
    allowsAffectedSessionCount: false,
    requiresProvider: false,
  },
  [AuthAuditEventCode.SESSIONS_REVOKED_ALL]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.LOGOUT_ALL_REQUESTED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: true,
    requiresProvider: false,
  },
  [AuthAuditEventCode.ACCOUNT_DELETED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.ACCOUNT_DELETION_COMPLETED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: true,
    requiresProvider: false,
  },
  [AuthAuditEventCode.REFRESH_REPLAY_DETECTED]: {
    outcome: AuthAuditOutcome.DENIED,
    reasonCode: AuthAuditReasonCode.REFRESH_TOKEN_REPLAY,
    sessionPolicy: 'required',
    allowsAffectedSessionCount: false,
    requiresProvider: false,
  },
  [AuthAuditEventCode.OAUTH_LINKED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: false,
    requiresProvider: true,
  },
  [AuthAuditEventCode.OAUTH_UNLINKED]: {
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_UNLINKED,
    sessionPolicy: 'forbidden',
    allowsAffectedSessionCount: false,
    requiresProvider: true,
  },
};

@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  private readonly retentionDays: number;

  constructor(
    @InjectModel(AuthAuditEvent.name)
    private readonly auditModel: Model<AuthAuditEvent>,
    private readonly configService: ConfigService,
  ) {
    this.retentionDays = this.resolveRetentionDays();
  }

  async record(input: RecordAuthAuditInput): Promise<void> {
    const metadata = this.normalizeMetadata(input.metadata);

    this.validateInput(input, metadata);

    const expiresAt = new Date(
      Date.now() + this.retentionDays * DAY_IN_MILLISECONDS,
    );

    try {
      await this.auditModel.insertMany(
        [
          {
            eventCode: input.eventCode,
            outcome: input.outcome,
            reasonCode: input.reasonCode,
            targetUserId: new Types.ObjectId(input.targetUserId),
            actorUserId: input.actorUserId
              ? new Types.ObjectId(input.actorUserId)
              : null,
            sessionPublicId: input.sessionPublicId,
            metadata,
            expiresAt,
          },
        ],
        {
          session: input.mongoSession,
        },
      );
    } catch (error: unknown) {
      this.logPersistenceFailure(input.eventCode, error);

      if (input.mongoSession) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Không thể ghi nhận sự kiện bảo mật',
      );
    }
  }

  private validateInput(
    input: RecordAuthAuditInput,
    metadata?: AuthAuditMetadata,
  ): void {
    const policies = AUTH_AUDIT_POLICIES as Partial<
      Record<string, AuthAuditPolicy>
    >;

    const policy = policies[input.eventCode];

    if (!policy) {
      throw new TypeError('Invalid auth audit event code');
    }

    if (input.outcome !== policy.outcome) {
      throw new TypeError('Invalid outcome for auth audit event');
    }

    if (input.reasonCode !== policy.reasonCode) {
      throw new TypeError('Invalid reason for auth audit event');
    }

    this.assertObjectId(input.targetUserId, 'targetUserId');

    if (input.actorUserId !== undefined && input.actorUserId !== null) {
      this.assertObjectId(input.actorUserId, 'actorUserId');
    }

    if (
      policy.sessionPolicy === 'required' &&
      input.sessionPublicId === undefined
    ) {
      throw new TypeError('sessionPublicId is required for this event');
    }

    if (
      policy.sessionPolicy === 'forbidden' &&
      input.sessionPublicId !== undefined
    ) {
      throw new TypeError('sessionPublicId is not allowed for this event');
    }

    if (
      input.sessionPublicId !== undefined &&
      !AUTH_AUDIT_SESSION_ID_PATTERN.test(input.sessionPublicId)
    ) {
      throw new TypeError('Invalid sessionPublicId');
    }

    if (
      metadata?.affectedSessionCount !== undefined &&
      !policy.allowsAffectedSessionCount
    ) {
      throw new TypeError('affectedSessionCount is not allowed for this event');
    }

    if (policy.requiresProvider && metadata?.provider === undefined) {
      throw new TypeError('provider is required for this event');
    }

    if (!policy.requiresProvider && metadata?.provider !== undefined) {
      throw new TypeError('provider is not allowed for this event');
    }
  }

  private assertObjectId(
    value: unknown,
    fieldName: string,
  ): asserts value is Types.ObjectId {
    if (!(value instanceof Types.ObjectId)) {
      throw new TypeError(`${fieldName} must be a MongoDB ObjectId`);
    }
  }

  private normalizeMetadata(
    metadata?: AuthAuditMetadata,
  ): AuthAuditMetadata | undefined {
    if (metadata === undefined) {
      return undefined;
    }

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new TypeError('Audit metadata must be an object');
    }

    const prototype = Object.getPrototypeOf(metadata) as object | null;

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Audit metadata must be a plain object');
    }

    const source = metadata as Record<string, unknown>;

    for (const key of Object.keys(source)) {
      if (!ALLOWED_METADATA_KEYS.has(key as keyof AuthAuditMetadata)) {
        throw new TypeError(`Unsupported audit metadata: ${key}`);
      }
    }

    const normalized: AuthAuditMetadata = {};

    if (metadata.affectedSessionCount !== undefined) {
      if (
        !Number.isSafeInteger(metadata.affectedSessionCount) ||
        metadata.affectedSessionCount < 0 ||
        metadata.affectedSessionCount > 10_000
      ) {
        throw new TypeError('Invalid affectedSessionCount');
      }

      normalized.affectedSessionCount = metadata.affectedSessionCount;
    }

    if (metadata.provider !== undefined) {
      if (!Object.values(AuthAuditProvider).includes(metadata.provider)) {
        throw new TypeError('Invalid auth provider');
      }

      normalized.provider = metadata.provider;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private resolveRetentionDays(): number {
    const rawValue = this.configService.get<unknown>(
      'AUTH_AUDIT_RETENTION_DAYS',
    );

    if (
      rawValue === undefined ||
      rawValue === null ||
      (typeof rawValue === 'string' && rawValue.trim() === '')
    ) {
      return AUTH_AUDIT_DEFAULT_RETENTION_DAYS;
    }

    const value =
      typeof rawValue === 'number'
        ? rawValue
        : typeof rawValue === 'string'
          ? Number(rawValue.trim())
          : Number.NaN;

    if (
      !Number.isSafeInteger(value) ||
      value < MIN_RETENTION_DAYS ||
      value > MAX_RETENTION_DAYS
    ) {
      throw new Error(
        `AUTH_AUDIT_RETENTION_DAYS must be an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`,
      );
    }

    return value;
  }

  private logPersistenceFailure(
    eventCode: AuthAuditEventCode,
    error: unknown,
  ): void {
    const details = this.readErrorDetails(error);

    this.logger.error(
      [
        'Failed to persist auth audit event',
        `eventCode=${eventCode}`,
        `errorName=${details.name}`,
        `errorCode=${details.code ?? 'none'}`,
        `errorLabels=${details.labels.join(',') || 'none'}`,
      ].join(' '),
    );
  }

  private readErrorDetails(error: unknown): {
    name: string;
    code?: string | number;
    labels: string[];
  } {
    if (typeof error !== 'object' || error === null) {
      return {
        name: 'UnknownError',
        labels: [],
      };
    }

    const source = error as Record<string, unknown>;

    const code =
      typeof source.code === 'string' || typeof source.code === 'number'
        ? source.code
        : undefined;

    const labels = Array.isArray(source.errorLabels)
      ? source.errorLabels
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 5)
      : [];

    return {
      name: error instanceof Error ? error.name : 'UnknownError',
      code,
      labels,
    };
  }
}
