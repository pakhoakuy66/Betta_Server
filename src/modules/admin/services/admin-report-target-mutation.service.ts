import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { type ClientSession, type Model, Types } from 'mongoose';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { CanonicalModerationReasonCode } from '../../../common/moderation/moderation-reason.constants';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../auth/schemas/auth-session.schema';
import { Post, PostModerationState } from '../../posts/schemas/post.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import { ReportTargetType } from '../../reports/schemas/report.schema';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { User } from '../../users/schemas/user.schema';
import { isActiveUserRestriction } from '../../users/utils/user-restriction';
import {
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  AdminReportDecision,
  AdminReportDecisionOutcome,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';
import { AdminPostModerationOperation } from '../constants/admin-post-moderation.constants';
import {
  ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
  ADMIN_USER_RESTRICTION_EVENT_TYPE,
} from '../constants/admin-user-restriction.constants';
import { isValidAdminUserPublicId } from '../constants/admin-user-query.constants';
import { AdminReportDecisionConflictException } from '../exceptions/admin-report-decision-conflict.exception';
import type { AdminReportDecisionActor } from '../interfaces/admin-report-decision.interface';
import type { AdminPostModerationTransition } from '../interfaces/admin-post-moderation.interface';
import { AdminAuditService } from './admin-audit.service';
import { AdminPostLifecycleService } from './admin-post-lifecycle.service';

export type DecisionReport = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  targetSnapshot?: {
    publicId?: string;
    expireAt?: Date | null;
  };
  version: number;
}>;

type StoredPost = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  expireAt: Date;
  isDeletedByAdmin: boolean;
  moderationState?: PostModerationState;
  moderationVersion?: number;
}>;

type StoredUser = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  fullname: string;
  isDeleted: boolean;
  restriction: {
    type: UserRestrictionType;
    effectiveAt: Date;
    expiresAt: Date | null;
    supportReference: string;
    publicReasonCode: string;
  } | null;
  version: number;
}>;

export type TargetAvailability =
  | 'AVAILABLE'
  | 'EXPIRED'
  | 'DELETED'
  | 'UNAVAILABLE';

export type InspectedReportTarget = Readonly<{
  availability: TargetAvailability;
  publicId: string;
  immutableSnapshotPublicId: string | null;
  immutableSnapshotMatchesTarget: boolean;
  displayName?: string;
  post?: StoredPost;
  user?: StoredUser;
}>;

export type AppliedReportTarget = Readonly<{
  publicId: string;
  displayName?: string;
  beforeVersion: number;
  afterVersion: number;
  beforeState: string;
  afterState: string;
  revokedSessionCount: number;
  restriction?: Readonly<{
    type: UserRestrictionType;
    effectiveAt: Date;
    expiresAt: Date | null;
    supportReference: string;
    publicReasonCode: string;
  }>;
  postTransition?: AdminPostModerationTransition;
}>;

export type TargetMutationInput = Readonly<{
  actor: AdminReportDecisionActor;
  decision: AdminReportDecision;
  targetAction: AdminReportTargetAction;
  expectedTargetVersion?: number;
  reasonCode: CanonicalModerationReasonCode;
  actionReasonCode?: CanonicalModerationReasonCode;
  publicReasonCode?: string;
  expiresAt?: Date;
  reasonNote: string;
  correlationId?: string;
}>;

const POST_PROJECTION =
  '_id publicId expireAt isDeletedByAdmin +moderationState +moderationVersion';
const USER_PROJECTION = '_id publicId fullname isDeleted +restriction +version';

@Injectable()
export class AdminReportTargetMutationService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AuthSession.name)
    private readonly userSessions: Model<AuthSession>,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
    private readonly postLifecycle: AdminPostLifecycleService,
  ) {}

  async inspect(
    report: DecisionReport,
    now: Date,
    session: ClientSession,
  ): Promise<InspectedReportTarget> {
    const immutableSnapshotPublicId = this.immutableSnapshotPublicId(report);

    if (report.targetType === ReportTargetType.POST) {
      const post = await this.posts
        .findById(report.targetId)
        .select(POST_PROJECTION)
        .session(session)
        .lean<StoredPost | null>()
        .exec();
      if (!post) {
        return Object.freeze({
          availability: 'UNAVAILABLE',
          publicId: immutableSnapshotPublicId ?? '',
          immutableSnapshotPublicId,
          immutableSnapshotMatchesTarget: immutableSnapshotPublicId !== null,
        });
      }
      if (post.expireAt.getTime() <= now.getTime()) {
        return Object.freeze({
          availability: 'EXPIRED',
          publicId: immutableSnapshotPublicId ?? '',
          immutableSnapshotPublicId,
          immutableSnapshotMatchesTarget:
            immutableSnapshotPublicId === post.publicId,
          post,
        });
      }
      if (
        post.moderationState === PostModerationState.TERMINAL_DELETED ||
        (post.isDeletedByAdmin &&
          post.moderationState !== PostModerationState.HIDDEN)
      ) {
        return Object.freeze({
          availability: 'DELETED',
          publicId: immutableSnapshotPublicId ?? '',
          immutableSnapshotPublicId,
          immutableSnapshotMatchesTarget:
            immutableSnapshotPublicId === post.publicId,
          post,
        });
      }
      return Object.freeze({
        availability: 'AVAILABLE',
        publicId: post.publicId,
        immutableSnapshotPublicId,
        immutableSnapshotMatchesTarget:
          immutableSnapshotPublicId === post.publicId,
        post,
      });
    }

    const user = await this.users
      .findById(report.targetId)
      .select(USER_PROJECTION)
      .session(session)
      .lean<StoredUser | null>()
      .exec();
    if (!user) {
      return Object.freeze({
        availability: 'UNAVAILABLE',
        publicId: immutableSnapshotPublicId ?? '',
        immutableSnapshotPublicId,
        immutableSnapshotMatchesTarget: immutableSnapshotPublicId !== null,
      });
    }
    if (user.isDeleted) {
      return Object.freeze({
        availability: 'DELETED',
        publicId: immutableSnapshotPublicId ?? '',
        immutableSnapshotPublicId,
        immutableSnapshotMatchesTarget:
          immutableSnapshotPublicId === user.publicId,
        displayName: user.fullname,
        user,
      });
    }
    return Object.freeze({
      availability: 'AVAILABLE',
      publicId: user.publicId,
      immutableSnapshotPublicId,
      immutableSnapshotMatchesTarget:
        immutableSnapshotPublicId === user.publicId,
      displayName: user.fullname,
      user,
    });
  }

  outcome(
    input: TargetMutationInput,
    target: InspectedReportTarget,
  ): AdminReportDecisionOutcome {
    if (input.decision === AdminReportDecision.REJECT) {
      return AdminReportDecisionOutcome.REPORT_REJECTED;
    }
    if (target.availability === 'AVAILABLE') {
      if (input.targetAction === AdminReportTargetAction.NONE) {
        throw new BadRequestException(
          'Target còn khả dụng nên resolve phải có action',
        );
      }
      this.assertType(input.targetAction, target);
      return AdminReportDecisionOutcome.ACTION_APPLIED;
    }
    if (input.targetAction !== AdminReportTargetAction.NONE) {
      throw new AdminReportDecisionConflictException(
        'Target không còn khả dụng để thực hiện action',
      );
    }
    this.assertImmutableSnapshot(target);

    const expected =
      target.availability === 'EXPIRED'
        ? CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION
        : target.availability === 'DELETED'
          ? CanonicalModerationReasonCode.TARGET_DELETED_NO_ACTION
          : CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION;
    if (input.reasonCode !== expected) {
      throw new AdminReportDecisionConflictException(
        'Trạng thái target không khớp no-action outcome',
      );
    }
    return target.availability === 'EXPIRED'
      ? AdminReportDecisionOutcome.TARGET_EXPIRED_NO_ACTION
      : target.availability === 'DELETED'
        ? AdminReportDecisionOutcome.TARGET_DELETED_NO_ACTION
        : AdminReportDecisionOutcome.TARGET_UNAVAILABLE_NO_ACTION;
  }

  async apply(
    report: DecisionReport,
    target: InspectedReportTarget,
    input: TargetMutationInput,
    now: Date,
    session: ClientSession,
  ): Promise<AppliedReportTarget> {
    return target.post
      ? this.applyPost(report, target.post, input, now, session)
      : this.applyUser(report, target.user as StoredUser, input, now, session);
  }

  async recordAudit(
    report: DecisionReport,
    target: AppliedReportTarget,
    input: TargetMutationInput,
    session: ClientSession,
  ): Promise<void> {
    const action =
      input.targetAction === AdminReportTargetAction.POST_HIDE
        ? AdminAuditAction.POST_HIDDEN
        : input.targetAction === AdminReportTargetAction.POST_TERMINAL_DELETE
          ? AdminAuditAction.POST_DELETED
          : input.targetAction ===
              AdminReportTargetAction.USER_TEMPORARY_SUSPENSION
            ? AdminAuditAction.USER_SUSPENDED
            : AdminAuditAction.USER_BANNED;
    await this.audit.record({
      action,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: input.actor,
      target: {
        type:
          report.targetType === ReportTargetType.POST
            ? AdminAuditTargetType.POST
            : AdminAuditTargetType.USER,
        publicId: target.publicId,
        displayName: target.displayName,
      },
      reasonCode: input.actionReasonCode as string,
      reasonNote: input.reasonNote,
      metadata: {
        beforeVersion: target.beforeVersion,
        afterVersion: target.afterVersion,
        beforeState: target.beforeState,
        afterState: target.afterState,
        affectedSessionCount: target.revokedSessionCount,
      },
      correlationId: input.correlationId,
      source: AdminAuditSource.HTTP,
      mongoSession: session,
    });
  }

  async enqueue(
    report: DecisionReport,
    target: AppliedReportTarget,
    input: TargetMutationInput,
    session: ClientSession,
  ): Promise<void> {
    if (report.targetType === ReportTargetType.POST) {
      if (!target.postTransition) {
        throw new Error('Post lifecycle transition is missing');
      }
      await this.postLifecycle.enqueue({
        transition: target.postTransition,
        operation: this.postOperation(input.targetAction),
        correlationId: input.correlationId,
        mongoSession: session,
      });
      return;
    }

    await this.outbox.enqueue({
      eventType: ADMIN_USER_RESTRICTION_EVENT_TYPE,
      dedupeKey: `user-restriction:${target.publicId}:${target.afterVersion}`,
      aggregateType: ADMIN_USER_RESTRICTION_AGGREGATE_TYPE,
      aggregatePublicId: target.publicId,
      payload: {
        schemaVersion: 1,
        operation: 'APPLY',
        userPublicId: target.publicId,
        restrictionType: target.restriction?.type as string,
        restriction: {
          type: target.restriction?.type as string,
          effectiveAt: target.restriction?.effectiveAt.toISOString() as string,
          expiresAt: target.restriction?.expiresAt?.toISOString() ?? null,
          supportReference: target.restriction?.supportReference as string,
          publicReasonCode: target.restriction?.publicReasonCode as string,
        },
        beforeVersion: target.beforeVersion,
        afterVersion: target.afterVersion,
      },
      correlationId: input.correlationId,
      mongoSession: session,
    });
  }

  private assertType(
    action: AdminReportTargetAction,
    target: InspectedReportTarget,
  ): void {
    const postAction =
      action === AdminReportTargetAction.POST_HIDE ||
      action === AdminReportTargetAction.POST_TERMINAL_DELETE;
    if ((postAction && !target.post) || (!postAction && !target.user)) {
      throw new BadRequestException('Target action không khớp loại report');
    }
  }

  private immutableSnapshotPublicId(report: DecisionReport): string | null {
    const publicId = report.targetSnapshot?.publicId?.trim();
    if (!publicId) return null;

    const valid =
      report.targetType === ReportTargetType.POST
        ? isValidPostPublicId(publicId)
        : isValidAdminUserPublicId(publicId);
    return valid ? publicId : null;
  }

  private assertImmutableSnapshot(target: InspectedReportTarget): void {
    if (
      target.immutableSnapshotPublicId === null ||
      !target.immutableSnapshotMatchesTarget
    ) {
      throw new AdminReportDecisionConflictException(
        'Không thể đóng report do immutable target snapshot không hợp lệ',
      );
    }
  }

  private async applyPost(
    report: DecisionReport,
    _post: StoredPost,
    input: TargetMutationInput,
    now: Date,
    session: ClientSession,
  ): Promise<AppliedReportTarget> {
    const transition = await this.postLifecycle.transition(
      {
        actorPublicId: input.actor.publicId,
        postId: report.targetId,
        operation: this.postOperation(input.targetAction),
        expectedModerationVersion: input.expectedTargetVersion as number,
        reasonCode: input.actionReasonCode as CanonicalModerationReasonCode,
        reasonNote: input.reasonNote,
        correlationId: input.correlationId,
      },
      session,
      now,
    );
    return Object.freeze({
      publicId: transition.postPublicId,
      beforeVersion: transition.beforeVersion,
      afterVersion: transition.afterVersion,
      beforeState: transition.beforeState,
      afterState: transition.afterState,
      revokedSessionCount: 0,
      postTransition: transition,
    });
  }

  private postOperation(
    action: AdminReportTargetAction,
  ): AdminPostModerationOperation {
    if (action === AdminReportTargetAction.POST_HIDE) {
      return AdminPostModerationOperation.HIDE;
    }
    if (action === AdminReportTargetAction.POST_TERMINAL_DELETE) {
      return AdminPostModerationOperation.TERMINAL_DELETE;
    }
    throw new BadRequestException('Target action không phải Post action');
  }

  private async applyUser(
    report: DecisionReport,
    user: StoredUser,
    input: TargetMutationInput,
    now: Date,
    session: ClientSession,
  ): Promise<AppliedReportTarget> {
    const beforeRestrictionType = user.restriction?.type ?? 'NONE';
    if (
      user.version !== input.expectedTargetVersion ||
      isActiveUserRestriction(user.restriction, now)
    ) {
      throw this.staleTarget();
    }
    const type =
      input.targetAction === AdminReportTargetAction.USER_TEMPORARY_SUSPENSION
        ? UserRestrictionType.TEMPORARY_SUSPENSION
        : UserRestrictionType.INDEFINITE_BAN;
    if (
      type === UserRestrictionType.TEMPORARY_SUSPENSION &&
      (input.expiresAt as Date).getTime() <= now.getTime()
    ) {
      throw new BadRequestException('Temporary suspension expiry không hợp lệ');
    }
    const restriction = {
      type,
      effectiveAt: now,
      expiresAt:
        type === UserRestrictionType.TEMPORARY_SUSPENSION
          ? (input.expiresAt as Date)
          : null,
      supportReference: `sup_${randomBytes(16).toString('base64url')}`,
      publicReasonCode: input.publicReasonCode as string,
    };
    const updated = await this.users
      .findOneAndUpdate(
        {
          _id: report.targetId,
          publicId: user.publicId,
          isDeleted: false,
          version: input.expectedTargetVersion,
        },
        {
          $set: { restriction },
          $inc: { version: 1, authzVersion: 1 },
        },
        {
          session,
          returnDocument: 'after',
          runValidators: true,
        },
      )
      .select(USER_PROJECTION)
      .lean<StoredUser | null>()
      .exec();
    if (!updated) throw this.staleTarget();

    const revoked = await this.userSessions.updateMany(
      { userId: user._id, revokedAt: null },
      {
        $set: {
          revokedAt: now,
          revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
        },
      },
      { session },
    );

    return Object.freeze({
      publicId: updated.publicId,
      displayName: updated.fullname,
      beforeVersion: user.version,
      afterVersion: updated.version,
      beforeState: beforeRestrictionType,
      afterState: type,
      revokedSessionCount: revoked.modifiedCount,
      restriction: Object.freeze(restriction),
    });
  }

  private staleTarget(): ConflictException {
    return new AdminReportDecisionConflictException(
      'Target đã được cập nhật bởi yêu cầu khác',
    );
  }
}
