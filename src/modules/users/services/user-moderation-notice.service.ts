import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import type { ClaimedOutboxEvent } from '../../../common/outbox/outbox.interface';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { AdminUserDeletionOperation } from '../../admin/constants/admin-user-deletion.constants';
import { AdminUserRestrictionOperation } from '../../admin/constants/admin-user-restriction.constants';
import {
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
}>;

@Injectable()
export class UserModerationNoticeService {
  constructor(
    @InjectModel(UserModerationNotice.name)
    private readonly notices: Model<UserModerationNotice>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationsService,
  ) {}

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
      .select('_id publicId isDeleted status')
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

  private invalidEvent(): Error & { code: string } {
    const error = new Error(
      'Moderation outbox payload không hợp lệ',
    ) as Error & {
      code: string;
    };
    error.code = 'INVALID_MODERATION_EVENT';
    return error;
  }
}
