import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../auth/schemas/auth-session.schema';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { User } from '../../users/schemas/user.schema';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  ADMIN_USER_RESTRICTION_EXPIRY_BATCH_SIZE,
  ADMIN_USER_RESTRICTION_EXPIRY_CLOCK,
  ADMIN_USER_RESTRICTION_EXPIRY_CONCURRENCY,
  ADMIN_USER_RESTRICTION_EXPIRY_REASON_CODE,
  ADMIN_USER_RESTRICTION_EXPIRY_REASON_NOTE,
  ADMIN_USER_RESTRICTION_EXPIRY_SYSTEM_ACTOR,
  type AdminUserRestrictionExpiryClock,
} from '../constants/admin-user-restriction-expiry.constants';
import {
  ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
  ADMIN_USER_RESTRICTION_EVENT_TYPE,
  AdminUserRestrictionOperation,
} from '../constants/admin-user-restriction.constants';
import type {
  AdminUserRestrictionExpiryBatchResult,
  AdminUserRestrictionExpiryCandidate,
  AdminUserRestrictionExpiryResult,
} from '../interfaces/admin-user-restriction-expiry.interface';
import { AdminAuditService } from './admin-audit.service';

const CANDIDATE_SELECTION = '_id publicId fullname +version +restriction';

type ExpiredUser = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  fullname: string;
  version: number;
  authzVersion: number;
}>;

@Injectable()
export class AdminUserRestrictionExpiryService {
  private readonly logger = new Logger(AdminUserRestrictionExpiryService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AuthSession.name)
    private readonly targetSessions: Model<AuthSession>,
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
    @Inject(ADMIN_USER_RESTRICTION_EXPIRY_CLOCK)
    private readonly clock: AdminUserRestrictionExpiryClock,
  ) {}

  async expireDueRestrictions(
    now: Date = this.clock(),
  ): Promise<AdminUserRestrictionExpiryBatchResult> {
    this.assertClock(now);

    let candidates: AdminUserRestrictionExpiryCandidate[];
    try {
      candidates = await this.users
        .find({
          'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION,
          'restriction.expiresAt': { $lte: now },
        })
        .sort({ 'restriction.expiresAt': 1, _id: 1 })
        .limit(ADMIN_USER_RESTRICTION_EXPIRY_BATCH_SIZE)
        .select(CANDIDATE_SELECTION)
        .lean<AdminUserRestrictionExpiryCandidate[]>()
        .exec();
    } catch (error: unknown) {
      this.rethrowInfrastructure(error);
    }

    let expired = 0;
    let skipped = 0;
    let failed = 0;
    let cursor = 0;
    const workerCount = Math.min(
      ADMIN_USER_RESTRICTION_EXPIRY_CONCURRENCY,
      candidates.length,
    );

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < candidates.length) {
          const candidate = candidates[cursor++];
          try {
            const result = await this.expireCandidate(candidate, now);
            if (result) expired += 1;
            else skipped += 1;
          } catch (error: unknown) {
            failed += 1;
            this.logger.error(
              `Restriction expiry failed userPublicId=${candidate.publicId} ` +
                `errorCode=${this.errorCode(error)}`,
            );
          }
        }
      }),
    );

    return Object.freeze({
      scanned: candidates.length,
      expired,
      skipped,
      failed,
    });
  }

  async expireCandidate(
    candidate: AdminUserRestrictionExpiryCandidate,
    now: Date = this.clock(),
  ): Promise<AdminUserRestrictionExpiryResult | null> {
    this.assertClock(now);
    try {
      return await this.connection.transaction((mongoSession) =>
        this.expireCandidateInTransaction(candidate, now, mongoSession),
      );
    } catch (error: unknown) {
      this.rethrowInfrastructure(error);
    }
  }

  async convergeForAuthentication(
    userId: Types.ObjectId,
    now: Date,
    mongoSession: ClientSession,
  ): Promise<AdminUserRestrictionExpiryResult | null> {
    this.assertClock(now);
    if (!(userId instanceof Types.ObjectId)) {
      throw new TypeError('User ID expiry convergence không hợp lệ');
    }
    if (mongoSession.inTransaction() !== true) {
      throw new TypeError(
        'Expiry convergence khi authentication cần transaction đang active',
      );
    }

    try {
      const candidate = await this.users
        .findOne({
          _id: userId,
          'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION,
          'restriction.expiresAt': { $lte: now },
        })
        .session(mongoSession)
        .select(CANDIDATE_SELECTION)
        .lean<AdminUserRestrictionExpiryCandidate | null>()
        .exec();

      return candidate
        ? await this.expireCandidateInTransaction(candidate, now, mongoSession)
        : null;
    } catch (error: unknown) {
      this.rethrowInfrastructure(error);
    }
  }

  private async expireCandidateInTransaction(
    candidate: AdminUserRestrictionExpiryCandidate,
    now: Date,
    mongoSession: ClientSession,
  ): Promise<AdminUserRestrictionExpiryResult | null> {
    if (mongoSession.inTransaction() !== true) {
      throw new TypeError('Restriction expiry cần transaction đang active');
    }

    const updated = await this.users
      .findOneAndUpdate(
        {
          _id: candidate._id,
          publicId: candidate.publicId,
          version: candidate.version,
          'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION,
          'restriction.expiresAt': {
            $eq: candidate.restriction.expiresAt,
            $lte: now,
          },
        },
        {
          $set: { restriction: null },
          $inc: { version: 1, authzVersion: 1 },
        },
        {
          session: mongoSession,
          returnDocument: 'after',
          runValidators: true,
        },
      )
      .select('_id publicId fullname +version +authzVersion')
      .lean<ExpiredUser | null>()
      .exec();

    if (!updated) return null;

    const revoked = await this.targetSessions.updateMany(
      { userId: updated._id, revokedAt: null },
      {
        $set: {
          revokedAt: now,
          revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
        },
      },
      { session: mongoSession },
    );

    await this.outbox.enqueue({
      eventType: ADMIN_USER_RESTRICTION_EVENT_TYPE,
      dedupeKey: `user-restriction:${updated.publicId}:${updated.version}`,
      aggregateType: ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
      aggregatePublicId: updated.publicId,
      payload: {
        schemaVersion: 1,
        operation: AdminUserRestrictionOperation.REMOVE,
        userPublicId: updated.publicId,
        restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
        restriction: null,
        beforeVersion: candidate.version,
        afterVersion: updated.version,
      },
      mongoSession,
    });

    await this.audit.record({
      action: AdminAuditAction.USER_UNSUSPENDED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: ADMIN_USER_RESTRICTION_EXPIRY_SYSTEM_ACTOR,
      },
      target: {
        type: AdminAuditTargetType.USER,
        publicId: updated.publicId,
        displayName: updated.fullname,
      },
      reasonCode: ADMIN_USER_RESTRICTION_EXPIRY_REASON_CODE,
      reasonNote: ADMIN_USER_RESTRICTION_EXPIRY_REASON_NOTE,
      metadata: {
        beforeVersion: candidate.version,
        afterVersion: updated.version,
        beforeState: UserRestrictionType.TEMPORARY_SUSPENSION,
        afterState: 'NONE',
        affectedSessionCount: revoked.modifiedCount,
      },
      source: AdminAuditSource.WORKER,
      mongoSession,
    });

    return Object.freeze({
      userPublicId: updated.publicId,
      beforeVersion: candidate.version,
      afterVersion: updated.version,
      authzVersion: updated.authzVersion,
      revokedSessionCount: revoked.modifiedCount,
    });
  }

  private assertClock(now: Date): void {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('Restriction expiry clock không hợp lệ');
    }
  }

  private rethrowInfrastructure(error: unknown): never {
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Không thể hội tụ trạng thái restriction',
      );
    }
    throw error;
  }

  private errorCode(error: unknown): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code.slice(0, 64);
    }
    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  }
}
