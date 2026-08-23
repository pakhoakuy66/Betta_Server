import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { User } from '../../users/schemas/user.schema';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import {
  ADMIN_USER_MODERATION_HISTORY_ACTIONS,
  ADMIN_USER_MODERATION_HISTORY_MAX_OFFSET,
  type AdminUserModerationHistoryAction,
} from '../constants/admin-user-moderation-history.constants';
import type {
  AdminUserModerationHistoryPage,
  AdminUserModerationHistoryQuery,
  PublicAdminUserModerationHistoryItem,
} from '../interfaces/admin-user-moderation-history.interface';
import {
  AdminAuditEvent,
  type AdminAuditMetadata,
} from '../schemas/admin-audit-event.schema';

type StoredHistoryEvent = Readonly<{
  publicId: string;
  action: AdminUserModerationHistoryAction;
  outcome: AdminAuditOutcome;
  actor: Readonly<{
    type: AdminAuditActorType;
    publicId?: string;
    role?: string;
    displayName?: string;
  }>;
  reasonCode: string;
  reasonNote?: string;
  metadata?: AdminAuditMetadata;
  occurredAt: Date;
}>;

@Injectable()
export class AdminUserModerationHistoryService {
  constructor(
    @InjectModel(AdminAuditEvent.name)
    private readonly auditEvents: Model<AdminAuditEvent>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async list(
    query: AdminUserModerationHistoryQuery,
  ): Promise<AdminUserModerationHistoryPage> {
    this.validateQuery(query);
    const filter = this.buildFilter(query.targetPublicId);

    try {
      const records = await this.auditEvents
        .find(filter)
        .sort({ occurredAt: -1, publicId: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit + 1)
        .select(
          'publicId action outcome actor.type actor.publicId actor.role actor.displayName reasonCode reasonNote metadata occurredAt -_id',
        )
        .lean<StoredHistoryEvent[]>()
        .exec();

      if (records.length === 0) {
        await this.assertTargetOrHistoryExists(query.targetPublicId, filter);
      }

      const hasMore = records.length > query.limit;
      const items = records
        .slice(0, query.limit)
        .map((record) => this.toPublicItem(record));

      return Object.freeze({
        items: Object.freeze(items),
        pagination: Object.freeze({
          page: query.page,
          limit: query.limit,
          hasMore,
        }),
      });
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể truy vấn lịch sử moderation User',
        );
      }
      throw error;
    }
  }

  private validateQuery(query: AdminUserModerationHistoryQuery): void {
    if (!ADMIN_USER_PUBLIC_ID_PATTERN.test(query.targetPublicId)) {
      throw new BadRequestException('Public ID User không hợp lệ');
    }
    if (
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      (query.page - 1) * query.limit > ADMIN_USER_MODERATION_HISTORY_MAX_OFFSET
    ) {
      throw new BadRequestException(
        'Phân trang lịch sử moderation không hợp lệ',
      );
    }
  }

  private buildFilter(targetPublicId: string): Record<string, unknown> {
    return {
      action: { $in: ADMIN_USER_MODERATION_HISTORY_ACTIONS },
      outcome: AdminAuditOutcome.SUCCEEDED,
      'target.type': AdminAuditTargetType.USER,
      'target.publicId': targetPublicId,
      expiresAt: { $gt: new Date() },
    };
  }

  private async assertTargetOrHistoryExists(
    targetPublicId: string,
    historyFilter: Record<string, unknown>,
  ): Promise<void> {
    const [target, history] = await Promise.all([
      this.users.exists({ publicId: targetPublicId }).exec(),
      this.auditEvents.exists(historyFilter).exec(),
    ]);
    if (!target && !history) throw new NotFoundException('Không tìm thấy User');
  }

  private toPublicItem(
    record: StoredHistoryEvent,
  ): PublicAdminUserModerationHistoryItem {
    const actor = this.toPublicActor(record.actor);

    return Object.freeze({
      id: record.publicId,
      action: record.action,
      outcome: record.outcome,
      actor,
      reason: Object.freeze({
        code: record.reasonCode,
        note: record.reasonNote ?? null,
      }),
      transition: Object.freeze({
        beforeVersion: record.metadata?.beforeVersion ?? null,
        afterVersion: record.metadata?.afterVersion ?? null,
        beforeState: record.metadata?.beforeState ?? null,
        afterState: record.metadata?.afterState ?? null,
        affectedSessionCount: record.metadata?.affectedSessionCount ?? null,
      }),
      occurredAt: record.occurredAt.toISOString(),
    });
  }

  private toPublicActor(
    actor: StoredHistoryEvent['actor'],
  ): PublicAdminUserModerationHistoryItem['actor'] {
    if (
      actor.type === AdminAuditActorType.SYSTEM &&
      typeof actor.displayName === 'string' &&
      actor.displayName.length > 0
    ) {
      return Object.freeze({
        type: AdminAuditActorType.SYSTEM,
        displayName: actor.displayName,
      });
    }

    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      typeof actor.publicId !== 'string' ||
      (actor.role !== AdminRole.ADMIN && actor.role !== AdminRole.SUPER_ADMIN)
    ) {
      throw new TypeError('Moderation history actor không hợp lệ');
    }

    return Object.freeze({
      publicId: actor.publicId,
      role: actor.role,
    });
  }
}
