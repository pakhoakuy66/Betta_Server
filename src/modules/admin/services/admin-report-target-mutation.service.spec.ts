import { describe, expect, it } from '@jest/globals';
import { Types, type ClientSession, type Model } from 'mongoose';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { CanonicalModerationReasonCode } from '../../../common/moderation/moderation-reason.constants';
import { AuthSession } from '../../auth/schemas/auth-session.schema';
import { Post, PostModerationState } from '../../posts/schemas/post.schema';
import { ReportTargetType } from '../../reports/schemas/report.schema';
import { User } from '../../users/schemas/user.schema';
import {
  AdminReportDecision,
  AdminReportDecisionOutcome,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';
import { AdminReportDecisionConflictException } from '../exceptions/admin-report-decision-conflict.exception';
import { AdminAuditService } from './admin-audit.service';
import { AdminPostLifecycleService } from './admin-post-lifecycle.service';
import {
  AdminReportTargetMutationService,
  type DecisionReport,
  type TargetMutationInput,
} from './admin-report-target-mutation.service';

class LeanQuery<T> {
  constructor(private readonly value: T) {}

  select(): this {
    return this;
  }

  session(): this {
    return this;
  }

  lean(): this {
    return this;
  }

  exec(): Promise<T> {
    return Promise.resolve(this.value);
  }
}

const session = {} as ClientSession;
const postPublicId = 'post_23456789ABCD';
const userPublicId = 'usr_23456789AB';

describe('AdminReportTargetMutationService unavailable target closure', () => {
  const createService = (
    post: Readonly<Record<string, unknown>> | null,
    user: Readonly<Record<string, unknown>> | null = null,
  ): AdminReportTargetMutationService =>
    new AdminReportTargetMutationService(
      {
        findById: () => new LeanQuery(post),
      } as unknown as Model<Post>,
      {
        findById: () => new LeanQuery(user),
      } as unknown as Model<User>,
      {} as Model<AuthSession>,
      {} as AdminAuditService,
      {} as OutboxService,
      {} as AdminPostLifecycleService,
    );

  const report = (
    targetType: ReportTargetType,
    snapshotPublicId?: string,
  ): DecisionReport =>
    Object.freeze({
      _id: new Types.ObjectId(),
      publicId: 'rpt_23456789ABCDEFGH',
      reporterId: new Types.ObjectId(),
      targetType,
      targetId: new Types.ObjectId(),
      targetSnapshot: snapshotPublicId
        ? { publicId: snapshotPublicId, expireAt: new Date() }
        : {},
      version: 1,
    });

  const noAction = (
    reasonCode: CanonicalModerationReasonCode,
  ): TargetMutationInput =>
    ({
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      reasonCode,
    }) as TargetMutationInput;

  it('uses the immutable Post snapshot when the target is physically missing', async () => {
    const service = createService(null);
    const target = await service.inspect(
      report(ReportTargetType.POST, postPublicId),
      new Date(),
      session,
    );

    expect(target).toEqual(
      expect.objectContaining({
        availability: 'UNAVAILABLE',
        publicId: postPublicId,
        immutableSnapshotPublicId: postPublicId,
        immutableSnapshotMatchesTarget: true,
      }),
    );
    expect(
      service.outcome(
        noAction(CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION),
        target,
      ),
    ).toBe(AdminReportDecisionOutcome.TARGET_UNAVAILABLE_NO_ACTION);
  });

  it('fails closed instead of fabricating an unavailable target publicId', async () => {
    const service = createService(null);
    const target = await service.inspect(
      report(ReportTargetType.POST),
      new Date(),
      session,
    );

    expect(target.publicId).toBe('');
    expect(() =>
      service.outcome(
        noAction(CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION),
        target,
      ),
    ).toThrow(AdminReportDecisionConflictException);
  });

  it('fails closed when an expired target and its snapshot disagree', async () => {
    const expireAt = new Date(Date.now() - 60_000);
    const service = createService({
      _id: new Types.ObjectId(),
      publicId: postPublicId,
      expireAt,
      isDeletedByAdmin: false,
      moderationState: PostModerationState.ACTIVE,
      moderationVersion: 0,
    });
    const target = await service.inspect(
      report(ReportTargetType.POST, 'post_23456789ABCE'),
      new Date(),
      session,
    );

    expect(target.immutableSnapshotMatchesTarget).toBe(false);
    expect(() =>
      service.outcome(
        noAction(CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION),
        target,
      ),
    ).toThrow(AdminReportDecisionConflictException);
  });

  it('allows deleted User closure only with the matching immutable snapshot', async () => {
    const service = createService(null, {
      _id: new Types.ObjectId(),
      publicId: userPublicId,
      fullname: 'Deleted user',
      isDeleted: true,
      restriction: null,
      version: 3,
    });
    const target = await service.inspect(
      report(ReportTargetType.USER, userPublicId),
      new Date(),
      session,
    );

    expect(target.publicId).toBe(userPublicId);
    expect(
      service.outcome(
        noAction(CanonicalModerationReasonCode.TARGET_DELETED_NO_ACTION),
        target,
      ),
    ).toBe(AdminReportDecisionOutcome.TARGET_DELETED_NO_ACTION);
  });
});
