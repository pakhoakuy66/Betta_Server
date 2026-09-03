import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import type { ClaimedOutboxEvent } from '../../../common/outbox/outbox.interface';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../auth/schemas/auth-session.schema';
import { Post, PostModerationState } from '../../posts/schemas/post.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import {
  ADMIN_USER_DELETION_EVENT_TYPE,
  AdminUserDeletionOperation,
} from '../../admin/constants/admin-user-deletion.constants';
import {
  ADMIN_USER_RESTRICTION_EVENT_TYPE,
  AdminUserRestrictionOperation,
} from '../../admin/constants/admin-user-restriction.constants';
import {
  UserDeletionOrigin,
  UserRestrictionType,
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
} from '../constants/user-moderation.constants';
import {
  USER_MODERATION_NOTICE_RETENTION_DAYS,
  USER_MODERATION_NOTICE_TEMPORARY_GRACE_DAYS,
  UserModerationNoticeAction,
  UserModerationNoticeStatus,
  UserModerationPublicReason,
} from '../constants/user-moderation-notice.constants';
import { UserModerationNotice } from '../schemas/user-moderation-notice.schema';
import { User } from '../schemas/user.schema';
import { USER_PUBLIC_ID_PATTERN } from '../utils/generate-public-id';
import { generateModerationSupportReference } from '../utils/generate-user-moderation-notice-public-id';

type NoticeCandidate = Readonly<{
  sourceEventPublicId: string;
  sourceDedupeKey: string;
  targetUserId: Types.ObjectId;
  targetPublicId: string;
  noticeType: 'SYSTEM_MODERATION';
  publicAction: UserModerationNoticeAction;
  publicReasonCode: string;
  effectiveAt: Date;
  expiresAt: Date | null;
  supportReference: string;
  status: UserModerationNoticeStatus;
  occurredAt: Date;
  retentionExpiresAt: Date;
}>;

type DuplicateKeyError = Readonly<{ code?: number }>;
type UserTarget = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  isDeleted: boolean;
  status: string;
  version: number;
  deletionOrigin?: UserDeletionOrigin | null;
  restriction?: Readonly<{
    type: UserRestrictionType;
    effectiveAt: Date;
  }> | null;
}>;
type PostTarget = Readonly<{
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  publicId: string;
  moderationVersion: number;
}>;

@Injectable()
export class UserModerationNoticeService {
  constructor(
    @InjectModel(UserModerationNotice.name)
    private readonly notices: Model<UserModerationNotice>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationsService,
    @Optional()
    @InjectModel(Post.name)
    private readonly posts?: Model<Post>,
    @Optional()
    @InjectModel(AuthSession.name)
    private readonly sessions?: Model<AuthSession>,
  ) {}

  async reconcileSessionRevocation(event: ClaimedOutboxEvent): Promise<void> {
    const payload = this.payload(event);
    const restrictionApply =
      event.eventType === ADMIN_USER_RESTRICTION_EVENT_TYPE &&
      payload.operation === AdminUserRestrictionOperation.APPLY;
    const deletionApply =
      event.eventType === ADMIN_USER_DELETION_EVENT_TYPE &&
      payload.operation === AdminUserDeletionOperation.DELETE;
    if (!restrictionApply && !deletionApply) return;
    if (!this.sessions) throw this.invalidEvent();

    const afterVersion = payload.afterVersion;
    if (
      !Number.isSafeInteger(afterVersion) ||
      Number(afterVersion) < 1 ||
      !(event.occurredAt instanceof Date) ||
      Number.isNaN(event.occurredAt.getTime())
    ) {
      throw this.invalidEvent();
    }

    const target = await this.loadTarget(event);
    if (target.version > Number(afterVersion)) return;
    if (target.version !== Number(afterVersion)) throw this.invalidEvent();

    if (restrictionApply) {
      const restriction = this.record(payload.restriction);
      const restrictionType = payload.restrictionType;
      if (
        (restrictionType !== UserRestrictionType.TEMPORARY_SUSPENSION &&
          restrictionType !== UserRestrictionType.INDEFINITE_BAN) ||
        target.isDeleted ||
        target.restriction?.type !== restrictionType ||
        target.restriction.effectiveAt.getTime() !==
          this.date(restriction.effectiveAt).getTime()
      ) {
        throw this.invalidEvent();
      }
    }

    if (
      deletionApply &&
      (!target.isDeleted ||
        target.deletionOrigin !== UserDeletionOrigin.ADMIN_MODERATION)
    ) {
      throw this.invalidEvent();
    }

    await this.sessions
      .updateMany(
        {
          userId: target._id,
          revokedAt: null,
        },
        {
          $set: {
            revokedAt: event.occurredAt,
            revokeReason: restrictionApply
              ? SessionRevokeReason.ACCOUNT_RESTRICTED
              : SessionRevokeReason.ACCOUNT_DELETED,
          },
        },
      )
      .exec();
  }

  async consumePostEvent(event: ClaimedOutboxEvent): Promise<void> {
    if (!this.posts) throw this.invalidEvent();
    const payload = this.record(event.payload);
    const state = payload.state;
    const moderationVersion = payload.moderationVersion;
    if (
      event.schemaVersion !== 1 ||
      event.aggregateType !== 'post' ||
      !isValidPostPublicId(event.aggregatePublicId) ||
      payload.schemaVersion !== 1 ||
      payload.postPublicId !== event.aggregatePublicId ||
      (state !== PostModerationState.HIDDEN &&
        state !== PostModerationState.ACTIVE &&
        state !== PostModerationState.TERMINAL_DELETED) ||
      !Number.isSafeInteger(moderationVersion) ||
      Number(moderationVersion) < 1
    ) {
      throw this.invalidEvent();
    }

    const post = await this.posts
      .findOne({ publicId: event.aggregatePublicId })
      .select('_id authorId publicId +moderationVersion')
      .lean<PostTarget | null>()
      .exec();
    if (!post || post.moderationVersion < Number(moderationVersion)) {
      throw this.invalidEvent();
    }
    const target = await this.users
      .findById(post.authorId)
      .select('_id publicId isDeleted status')
      .lean<UserTarget | null>()
      .exec();
    if (!target) {
      await this.acknowledgePostNotice(post, Number(moderationVersion));
      return;
    }

    const suppliedReason = payload.publicReasonCode;
    if (
      typeof suppliedReason !== 'string' ||
      !USER_RESTRICTION_PUBLIC_REASON_PATTERN.test(suppliedReason)
    ) {
      throw this.invalidEvent();
    }
    const publicAction =
      state === PostModerationState.HIDDEN
        ? UserModerationNoticeAction.POST_HIDDEN
        : state === PostModerationState.ACTIVE
          ? UserModerationNoticeAction.POST_RESTORED
          : UserModerationNoticeAction.POST_TERMINAL_DELETED;
    const notice = await this.persist({
      sourceEventPublicId: event.publicId,
      sourceDedupeKey: event.dedupeKey,
      targetUserId: target._id,
      targetPublicId: target.publicId,
      noticeType: 'SYSTEM_MODERATION',
      publicAction,
      publicReasonCode: suppliedReason,
      effectiveAt: event.occurredAt,
      expiresAt: null,
      supportReference: generateModerationSupportReference(),
      status:
        state === PostModerationState.ACTIVE
          ? UserModerationNoticeStatus.RESOLVED
          : UserModerationNoticeStatus.ACTIVE,
      occurredAt: event.occurredAt,
      retentionExpiresAt: this.retention(event.occurredAt, null),
    });
    await this.notifyEligible(target, notice);
    await this.acknowledgePostNotice(post, Number(moderationVersion));
  }

  async consumeRestrictionEvent(event: ClaimedOutboxEvent): Promise<void> {
    const target = await this.loadTarget(event);
    const payload = this.payload(event);
    const operation = payload.operation;
    const restrictionType = payload.restrictionType;
    const isApply = operation === AdminUserRestrictionOperation.APPLY;

    if (
      (operation !== AdminUserRestrictionOperation.APPLY &&
        operation !== AdminUserRestrictionOperation.REMOVE) ||
      (restrictionType !== UserRestrictionType.TEMPORARY_SUSPENSION &&
        restrictionType !== UserRestrictionType.INDEFINITE_BAN)
    ) {
      throw this.invalidEvent();
    }

    const restriction = this.optionalRecord(payload.restriction);
    if (isApply && !restriction) throw this.invalidEvent();

    const effectiveAt = isApply
      ? this.date(restriction?.effectiveAt)
      : event.occurredAt;
    const expiresAt = isApply
      ? this.optionalDate(restriction?.expiresAt)
      : null;
    if (
      isApply &&
      restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION &&
      !expiresAt
    ) {
      throw this.invalidEvent();
    }
    if (
      isApply &&
      restrictionType === UserRestrictionType.INDEFINITE_BAN &&
      expiresAt
    ) {
      throw this.invalidEvent();
    }

    const suppliedSupportReference = restriction?.supportReference;
    const supportReference =
      isApply &&
      typeof suppliedSupportReference === 'string' &&
      USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN.test(suppliedSupportReference)
        ? suppliedSupportReference
        : generateModerationSupportReference();
    const suppliedReason = restriction?.publicReasonCode;
    const publicReasonCode =
      typeof suppliedReason === 'string' &&
      USER_RESTRICTION_PUBLIC_REASON_PATTERN.test(suppliedReason)
        ? suppliedReason
        : isApply
          ? UserModerationPublicReason.RESTRICTION_APPLIED
          : UserModerationPublicReason.RESTRICTION_REMOVED;

    const publicAction = this.restrictionAction(operation, restrictionType);
    const notice = await this.persist({
      sourceEventPublicId: event.publicId,
      sourceDedupeKey: event.dedupeKey,
      targetUserId: target._id,
      targetPublicId: target.publicId,
      noticeType: 'SYSTEM_MODERATION',
      publicAction,
      publicReasonCode,
      effectiveAt,
      expiresAt,
      supportReference,
      status: isApply
        ? UserModerationNoticeStatus.ACTIVE
        : UserModerationNoticeStatus.RESOLVED,
      occurredAt: event.occurredAt,
      retentionExpiresAt: this.retention(event.occurredAt, expiresAt),
    });

    if (!isApply) await this.notifyResolved(target, notice);
  }

  async consumeDeletionEvent(event: ClaimedOutboxEvent): Promise<void> {
    const target = await this.loadTarget(event);
    const payload = this.payload(event);
    const operation = payload.operation;
    if (
      operation !== AdminUserDeletionOperation.DELETE &&
      operation !== AdminUserDeletionOperation.RESTORE
    ) {
      throw this.invalidEvent();
    }
    const isDelete = operation === AdminUserDeletionOperation.DELETE;
    const deletion = this.record(payload.deletion);
    const effectiveAt = isDelete
      ? this.date(deletion.deletedAt)
      : event.occurredAt;
    const publicAction = isDelete
      ? UserModerationNoticeAction.ADMIN_SOFT_DELETE_APPLIED
      : UserModerationNoticeAction.ADMIN_SOFT_DELETE_RESTORED;
    const notice = await this.persist({
      sourceEventPublicId: event.publicId,
      sourceDedupeKey: event.dedupeKey,
      targetUserId: target._id,
      targetPublicId: target.publicId,
      noticeType: 'SYSTEM_MODERATION',
      publicAction,
      publicReasonCode: isDelete
        ? UserModerationPublicReason.ADMIN_DELETED
        : UserModerationPublicReason.ADMIN_RESTORED,
      effectiveAt,
      expiresAt: null,
      supportReference: generateModerationSupportReference(),
      status: isDelete
        ? UserModerationNoticeStatus.ACTIVE
        : UserModerationNoticeStatus.RESOLVED,
      occurredAt: event.occurredAt,
      retentionExpiresAt: this.retention(event.occurredAt, null),
    });

    if (!isDelete) await this.notifyResolved(target, notice);
  }

  private async loadTarget(event: ClaimedOutboxEvent): Promise<UserTarget> {
    if (
      event.schemaVersion !== 1 ||
      event.aggregateType !== 'user' ||
      !USER_PUBLIC_ID_PATTERN.test(event.aggregatePublicId)
    ) {
      throw this.invalidEvent();
    }
    const target = await this.users
      .findOne({ publicId: event.aggregatePublicId })
      .select(
        '_id publicId isDeleted status +version +deletionOrigin +restriction',
      )
      .lean<UserTarget | null>()
      .exec();
    if (!target) {
      const error = new Error('Moderation notice target không tồn tại');
      (error as Error & { code: string }).code = 'MODERATION_TARGET_NOT_FOUND';
      throw error;
    }
    return target;
  }

  private payload(event: ClaimedOutboxEvent): Record<string, unknown> {
    const payload = this.record(event.payload);
    if (
      payload.schemaVersion !== 1 ||
      payload.userPublicId !== event.aggregatePublicId
    ) {
      throw this.invalidEvent();
    }
    return payload;
  }

  private async persist(
    candidate: NoticeCandidate,
  ): Promise<UserModerationNotice> {
    try {
      const [created] = await this.notices.create([candidate]);
      return created;
    } catch (error: unknown) {
      if ((error as DuplicateKeyError)?.code !== 11000) throw error;
      const existing = await this.notices
        .findOne({ sourceEventPublicId: candidate.sourceEventPublicId })
        .exec();
      if (!existing || existing.sourceDedupeKey !== candidate.sourceDedupeKey) {
        const conflict = new Error('Moderation notice dedupe conflict');
        (conflict as Error & { code: string }).code =
          'MODERATION_NOTICE_DEDUPE_CONFLICT';
        throw conflict;
      }
      return existing;
    }
  }

  private async notifyResolved(
    target: UserTarget,
    notice: UserModerationNotice,
  ): Promise<void> {
    if (target.isDeleted || target.status !== 'active') return;
    await this.notifications.createSystemModerationNotification({
      recipientId: target._id,
      noticePublicId: notice.publicId,
      action: notice.publicAction,
      publicReasonCode: notice.publicReasonCode,
      effectiveAt: notice.effectiveAt,
      expiresAt: notice.expiresAt,
      supportReference: notice.supportReference,
    });
  }

  private async notifyEligible(
    target: UserTarget,
    notice: UserModerationNotice,
  ): Promise<void> {
    if (target.isDeleted || target.status !== 'active') return;
    await this.notifications.createSystemModerationNotification({
      recipientId: target._id,
      noticePublicId: notice.publicId,
      action: notice.publicAction,
      publicReasonCode: notice.publicReasonCode,
      effectiveAt: notice.effectiveAt,
      expiresAt: notice.expiresAt,
      supportReference: notice.supportReference,
    });
  }

  private async acknowledgePostNotice(
    post: PostTarget,
    moderationVersion: number,
  ): Promise<void> {
    if (!this.posts) throw this.invalidEvent();
    await this.posts
      .updateOne(
        {
          _id: post._id,
          moderationVersion: { $gte: moderationVersion },
        },
        { $max: { moderationNoticeVersion: moderationVersion } },
      )
      .exec();
  }

  private restrictionAction(
    operation: AdminUserRestrictionOperation,
    restrictionType: UserRestrictionType,
  ): UserModerationNoticeAction {
    if (restrictionType === UserRestrictionType.TEMPORARY_SUSPENSION) {
      return operation === AdminUserRestrictionOperation.APPLY
        ? UserModerationNoticeAction.TEMPORARY_SUSPENSION_APPLIED
        : UserModerationNoticeAction.TEMPORARY_SUSPENSION_REMOVED;
    }
    return operation === AdminUserRestrictionOperation.APPLY
      ? UserModerationNoticeAction.INDEFINITE_BAN_APPLIED
      : UserModerationNoticeAction.INDEFINITE_BAN_REMOVED;
  }

  private retention(occurredAt: Date, restrictionExpiry: Date | null): Date {
    const maximum = new Date(
      occurredAt.getTime() +
        USER_MODERATION_NOTICE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    if (!restrictionExpiry) return maximum;
    const grace = new Date(
      restrictionExpiry.getTime() +
        USER_MODERATION_NOTICE_TEMPORARY_GRACE_DAYS * 24 * 60 * 60 * 1_000,
    );
    return grace.getTime() < maximum.getTime() ? grace : maximum;
  }

  private record(value: unknown): Record<string, unknown> {
    const result = this.optionalRecord(value);
    if (!result) throw this.invalidEvent();
    return result;
  }

  private optionalRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private date(value: unknown): Date {
    const result = this.optionalDate(value);
    if (!result) throw this.invalidEvent();
    return result;
  }

  private optionalDate(value: unknown): Date | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw this.invalidEvent();
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw this.invalidEvent();
    return date;
  }

  private invalidEvent(): Error & { code: string; retryable: false } {
    const error = new Error(
      'Moderation outbox payload không hợp lệ',
    ) as Error & {
      code: string;
      retryable: false;
    };
    error.code = 'INVALID_MODERATION_EVENT';
    error.retryable = false;
    return error;
  }
}
