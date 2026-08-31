import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { Post, PostModerationState } from '../../posts/schemas/post.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import { Report } from '../../reports/schemas/report.schema';
import { SystemReport } from '../../reports/schemas/system-report.schema';
import { isReportPublicId } from '../../reports/utils/generate-report-public-id';
import { isSystemReportPublicId } from '../../reports/utils/generate-system-report-public-id';
import { User } from '../../users/schemas/user.schema';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_AUDIT_CORRELATION_ID_PATTERN,
  ADMIN_AUDIT_PUBLIC_ID_PATTERN,
  ADMIN_AUDIT_REASON_CODE_PATTERN,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  ADMIN_MODERATION_HISTORY_ACTIONS,
  ADMIN_MODERATION_HISTORY_MAX_OFFSET,
  ADMIN_MODERATION_HISTORY_MAX_LIMIT,
  type AdminModerationHistoryAction,
  AdminModerationHistoryResource,
  AdminModerationHistoryTargetAvailability,
  AdminModerationHistoryTargetType,
} from '../constants/admin-moderation-history.constants';
import { isValidAdminUserPublicId } from '../constants/admin-user-query.constants';
import type {
  AdminModerationHistoryPage,
  AdminModerationHistoryQuery,
  PublicAdminModerationHistoryItem,
} from '../interfaces/admin-moderation-history.interface';
import {
  AdminAuditEvent,
  type AdminAuditMetadata,
} from '../schemas/admin-audit-event.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

const SAFE_STATE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

type StoredHistoryEvent = Readonly<{
  publicId: string;
  action: AdminModerationHistoryAction;
  outcome: AdminAuditOutcome;
  actor: Readonly<{
    type: AdminAuditActorType;
    publicId?: string;
    role?: AdminRole;
  }>;
  reasonCode: string;
  metadata?: AdminAuditMetadata;
  correlationId?: string;
  occurredAt: Date;
}>;

type TargetDescriptor = Readonly<{
  publicType: AdminModerationHistoryTargetType;
  auditType: AdminAuditTargetType;
  actions: readonly AdminModerationHistoryAction[];
}>;

type TargetStatus = Readonly<{
  exists: boolean;
  availability: AdminModerationHistoryTargetAvailability;
}>;

@Injectable()
export class AdminModerationHistoryService {
  constructor(
    @InjectModel(AdminAuditEvent.name)
    private readonly auditEvents: Model<AdminAuditEvent>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(SystemReport.name)
    private readonly systemReports: Model<SystemReport>,
  ) {}

  async list(
    query: AdminModerationHistoryQuery,
  ): Promise<AdminModerationHistoryPage> {
    const descriptor = this.validateAndResolveTarget(query);
    const offset = (query.page - 1) * query.limit;
    const now = new Date();
    const baseFilter = this.buildBaseFilter(
      descriptor,
      query.targetPublicId,
      now,
    );

    try {
      const [records, targetStatus] = await Promise.all([
        this.auditEvents
          .find(baseFilter)
          .sort({ occurredAt: -1, publicId: 1 })
          .skip(offset)
          .limit(query.limit + 1)
          .select(
            'publicId action outcome actor.type actor.publicId actor.role reasonCode metadata.beforeVersion metadata.afterVersion metadata.beforeState metadata.afterState correlationId occurredAt -_id',
          )
          .lean<StoredHistoryEvent[]>()
          .exec(),
        this.loadTargetStatus(descriptor, query.targetPublicId),
      ]);

      if (!targetStatus.exists && records.length === 0) {
        const retainedHistory = await this.auditEvents
          .exists(baseFilter)
          .exec();
        if (!retainedHistory) {
          throw new NotFoundException('Không tìm thấy target moderation');
        }
      }

      const hasMore = records.length > query.limit;
      const pageRecords = records.slice(0, query.limit);
      const items = pageRecords.map((record) =>
        this.toPublicItem(record, descriptor),
      );

      return Object.freeze({
        target: Object.freeze({
          type: descriptor.publicType,
          publicId: query.targetPublicId,
          availability: targetStatus.availability,
        }),
        items: Object.freeze(items),
        pagination: Object.freeze({
          page: query.page,
          limit: query.limit,
          hasMore,
        }),
      });
    } catch (error: unknown) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể truy vấn lịch sử moderation',
        );
      }
      throw error;
    }
  }

  private validateAndResolveTarget(
    query: AdminModerationHistoryQuery,
  ): TargetDescriptor {
    if (
      !Object.values(AdminModerationHistoryResource).includes(query.resource) ||
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > ADMIN_MODERATION_HISTORY_MAX_LIMIT ||
      !Number.isSafeInteger((query.page - 1) * query.limit) ||
      (query.page - 1) * query.limit > ADMIN_MODERATION_HISTORY_MAX_OFFSET
    ) {
      throw new BadRequestException('Truy vấn lịch sử moderation không hợp lệ');
    }

    if (query.resource === AdminModerationHistoryResource.USER) {
      if (!isValidAdminUserPublicId(query.targetPublicId)) {
        throw new BadRequestException('Public ID User không hợp lệ');
      }
      return Object.freeze({
        publicType: AdminModerationHistoryTargetType.USER,
        auditType: AdminAuditTargetType.USER,
        actions: ADMIN_MODERATION_HISTORY_ACTIONS.USER,
      });
    }

    if (query.resource === AdminModerationHistoryResource.POST) {
      if (!isValidPostPublicId(query.targetPublicId)) {
        throw new BadRequestException('Public ID Post không hợp lệ');
      }
      return Object.freeze({
        publicType: AdminModerationHistoryTargetType.POST,
        auditType: AdminAuditTargetType.POST,
        actions: ADMIN_MODERATION_HISTORY_ACTIONS.POST,
      });
    }

    if (isReportPublicId(query.targetPublicId)) {
      return Object.freeze({
        publicType: AdminModerationHistoryTargetType.REPORT,
        auditType: AdminAuditTargetType.REPORT,
        actions: ADMIN_MODERATION_HISTORY_ACTIONS.REPORT,
      });
    }
    if (isSystemReportPublicId(query.targetPublicId)) {
      return Object.freeze({
        publicType: AdminModerationHistoryTargetType.SYSTEM_REPORT,
        auditType: AdminAuditTargetType.SYSTEM_REPORT,
        actions: ADMIN_MODERATION_HISTORY_ACTIONS.SYSTEM_REPORT,
      });
    }
    throw new BadRequestException('Public ID Report không hợp lệ');
  }

  private buildBaseFilter(
    descriptor: TargetDescriptor,
    targetPublicId: string,
    now: Date,
  ): Record<string, unknown> {
    return {
      action: { $in: descriptor.actions },
      outcome: AdminAuditOutcome.SUCCEEDED,
      'target.type': descriptor.auditType,
      'target.publicId': targetPublicId,
      expiresAt: { $gt: now },
    };
  }

  private async loadTargetStatus(
    descriptor: TargetDescriptor,
    targetPublicId: string,
  ): Promise<TargetStatus> {
    if (descriptor.publicType === AdminModerationHistoryTargetType.USER) {
      const user = await this.users
        .findOne({ publicId: targetPublicId })
        .select('isDeleted -_id')
        .lean<Readonly<{ isDeleted?: boolean }> | null>()
        .exec();
      return Object.freeze({
        exists: user !== null,
        availability:
          user && user.isDeleted !== true
            ? AdminModerationHistoryTargetAvailability.AVAILABLE
            : AdminModerationHistoryTargetAvailability.DELETED,
      });
    }

    if (descriptor.publicType === AdminModerationHistoryTargetType.POST) {
      const post = await this.posts
        .findOne({ publicId: targetPublicId })
        .select('+moderationState isDeletedByAdmin -_id')
        .lean<Readonly<{
          moderationState?: PostModerationState;
          isDeletedByAdmin?: boolean;
        }> | null>()
        .exec();
      const terminalDeleted =
        post?.moderationState === PostModerationState.TERMINAL_DELETED ||
        (post?.isDeletedByAdmin === true &&
          post.moderationState !== PostModerationState.HIDDEN);
      return Object.freeze({
        exists: post !== null,
        availability:
          post && !terminalDeleted
            ? AdminModerationHistoryTargetAvailability.AVAILABLE
            : AdminModerationHistoryTargetAvailability.DELETED,
      });
    }

    const target =
      descriptor.publicType === AdminModerationHistoryTargetType.REPORT
        ? await this.reports.exists({ publicId: targetPublicId }).exec()
        : await this.systemReports.exists({ publicId: targetPublicId }).exec();
    return Object.freeze({
      exists: target !== null,
      availability: target
        ? AdminModerationHistoryTargetAvailability.AVAILABLE
        : AdminModerationHistoryTargetAvailability.DELETED,
    });
  }

  private toPublicItem(
    record: StoredHistoryEvent,
    descriptor: TargetDescriptor,
  ): PublicAdminModerationHistoryItem {
    if (
      !ADMIN_AUDIT_PUBLIC_ID_PATTERN.test(record.publicId) ||
      !descriptor.actions.includes(record.action) ||
      record.outcome !== AdminAuditOutcome.SUCCEEDED ||
      !record.actor ||
      !Object.values(AdminAuditActorType).includes(record.actor.type) ||
      !ADMIN_AUDIT_REASON_CODE_PATTERN.test(record.reasonCode) ||
      !(record.occurredAt instanceof Date) ||
      Number.isNaN(record.occurredAt.getTime())
    ) {
      throw new TypeError('Moderation history record không hợp lệ');
    }
    const correlationId = record.correlationId ?? null;
    if (
      correlationId !== null &&
      !ADMIN_AUDIT_CORRELATION_ID_PATTERN.test(correlationId)
    ) {
      throw new TypeError('Moderation history correlation ID không hợp lệ');
    }

    return Object.freeze({
      id: record.publicId,
      action: record.action,
      outcome: record.outcome,
      actor: this.toPublicActor(record.actor),
      reasonCode: record.reasonCode,
      transition: Object.freeze({
        beforeVersion: this.safeVersion(record.metadata?.beforeVersion),
        afterVersion: this.safeVersion(record.metadata?.afterVersion),
        beforeState: this.safeState(record.metadata?.beforeState),
        afterState: this.safeState(record.metadata?.afterState),
      }),
      correlationId,
      occurredAt: record.occurredAt.toISOString(),
    });
  }

  private safeVersion(value: unknown): number | null {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new TypeError('Moderation history version không hợp lệ');
    }
    return Number(value);
  }

  private safeState(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !SAFE_STATE_PATTERN.test(value)) {
      throw new TypeError('Moderation history state không hợp lệ');
    }
    return value;
  }

  private toPublicActor(
    actor: StoredHistoryEvent['actor'],
  ): PublicAdminModerationHistoryItem['actor'] {
    if (actor.type !== AdminAuditActorType.ADMIN_ACCOUNT) {
      return Object.freeze({
        type: actor.type,
        publicId: null,
        role: null,
      });
    }
    if (
      !isValidAdminPublicId(actor.publicId) ||
      (actor.role !== AdminRole.ADMIN && actor.role !== AdminRole.SUPER_ADMIN)
    ) {
      throw new TypeError('Moderation history Admin actor không hợp lệ');
    }
    return Object.freeze({
      type: actor.type,
      publicId: actor.publicId,
      role: actor.role,
    });
  }
}
