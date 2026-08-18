import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { AuthSession } from '../../auth/schemas/auth-session.schema';
import { Report, ReportTargetType } from '../../reports/schemas/report.schema';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import {
  USER_STATUS,
  User,
  type UserStatus,
} from '../../users/schemas/user.schema';
import {
  ADMIN_USER_QUERY_MAX_LIMIT,
  ADMIN_USER_QUERY_MAX_OFFSET,
  ADMIN_USER_QUERY_MAX_PAGE,
  ADMIN_USER_QUERY_SEARCH_PATTERN,
  AdminUserDeletionFilter,
  AdminUserLoginLockFilter,
  AdminUserRestrictionFilter,
  AdminUserSort,
  isValidAdminUserPublicId,
} from '../constants/admin-user-query.constants';
import {
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  type AdminUserListQuery,
  type AdminUserPage,
  type PublicAdminUserActivitySummary,
  type PublicAdminUserDetail,
  type PublicUserSessionSummary,
} from '../interfaces/admin-user-query.interface';
import {
  type ManagedUserSource,
  toPublicAdminUserDetail,
  toPublicAdminUserListItem,
} from '../mappers/admin-user-management.mapper';
import { AdminAuditEvent } from '../schemas/admin-audit-event.schema';

const LIST_PROJECTION =
  '_id publicId username fullname email phone avatar status isDeleted deletedAt ' +
  'lastActive createdAt updatedAt +deletionOrigin +restorableUntil +restriction ' +
  '+version +lockedUntil';

const DETAIL_PROJECTION = `${LIST_PROJECTION} bio link streakCount postsCount followersCount followingCount`;

const PHONE_SEARCH_PATTERN = /^[+\d][\d\s().-]{7,20}$/;

const SORTS: Readonly<Record<AdminUserSort, Readonly<Record<string, 1 | -1>>>> =
  Object.freeze({
    [AdminUserSort.CREATED_AT_DESC]: Object.freeze({
      createdAt: -1,
      publicId: 1,
    }),
    [AdminUserSort.USERNAME_ASC]: Object.freeze({
      username: 1,
      publicId: 1,
    }),
  });

const USER_MODERATION_ACTIONS = Object.freeze([
  AdminAuditAction.USER_SUSPENDED,
  AdminAuditAction.USER_UNSUSPENDED,
  AdminAuditAction.USER_BANNED,
  AdminAuditAction.USER_UNBANNED,
  AdminAuditAction.USER_DELETED,
  AdminAuditAction.USER_RESTORED,
]);

type StoredSessionSummary = Readonly<{
  _id: Types.ObjectId;
  activeCount: number;
  lastActiveAt: Date;
}>;

type UserFilterClause = Readonly<Record<string, unknown>>;
type UserFilter = {
  status?: UserStatus;
  isDeleted?: boolean;
  lockedUntil?: Readonly<{ $gt: Date }>;
  'restriction.type'?: UserRestrictionType;
  $and?: UserFilterClause[];
};

@Injectable()
export class AdminUserQueryService {
  constructor(
    @InjectModel(User.name)
    private readonly users: Model<User>,
    @InjectModel(AuthSession.name)
    private readonly sessions: Model<AuthSession>,
    @InjectModel(Report.name)
    private readonly reports: Model<Report>,
    @InjectModel(AdminAuditEvent.name)
    private readonly auditEvents: Model<AdminAuditEvent>,
  ) {}

  async list(query: AdminUserListQuery): Promise<AdminUserPage> {
    const normalized = this.normalizeQuery(query);
    const filter = this.toFilter(normalized);

    try {
      const offset = (normalized.page - 1) * normalized.limit;
      const records = await this.users
        .find(filter)
        .sort(SORTS[normalized.sort])
        .skip(offset)
        .limit(normalized.limit + 1)
        .select(LIST_PROJECTION)
        .lean<ManagedUserSource[]>()
        .exec();
      const visible = records.slice(0, normalized.limit);
      const now = new Date();

      return Object.freeze({
        items: Object.freeze(
          visible.map((record) => toPublicAdminUserListItem(record, now)),
        ),
        pagination: Object.freeze({
          page: normalized.page,
          limit: normalized.limit,
          hasMore: records.length > normalized.limit,
        }),
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async detail(publicId: string): Promise<PublicAdminUserDetail> {
    if (!isValidAdminUserPublicId(publicId)) {
      throw new BadRequestException('User public ID không hợp lệ');
    }

    try {
      const user = await this.users
        .findOne({ publicId })
        .select(DETAIL_PROJECTION)
        .lean<ManagedUserSource | null>()
        .exec();

      if (!user) throw new NotFoundException('Không tìm thấy User');

      const [sessionSummary, activitySummary] = await Promise.all([
        this.loadSessionSummary(user._id),
        this.loadActivitySummary(user._id, user.publicId),
      ]);
      return toPublicAdminUserDetail(user, sessionSummary, activitySummary);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private normalizeQuery(query: AdminUserListQuery): AdminUserListQuery {
    const search = query.search?.trim();

    if (
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      query.page > ADMIN_USER_QUERY_MAX_PAGE ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > ADMIN_USER_QUERY_MAX_LIMIT ||
      !Object.values(AdminUserSort).includes(query.sort) ||
      (query.page - 1) * query.limit > ADMIN_USER_QUERY_MAX_OFFSET ||
      (query.status !== undefined &&
        !Object.values(USER_STATUS).includes(query.status)) ||
      (query.deletion !== undefined &&
        !Object.values(AdminUserDeletionFilter).includes(query.deletion)) ||
      (query.restriction !== undefined &&
        !Object.values(AdminUserRestrictionFilter).includes(
          query.restriction,
        )) ||
      (query.loginLock !== undefined &&
        !Object.values(AdminUserLoginLockFilter).includes(query.loginLock)) ||
      (search !== undefined && !ADMIN_USER_QUERY_SEARCH_PATTERN.test(search))
    ) {
      throw new BadRequestException('Admin User query không hợp lệ');
    }

    return Object.freeze({ ...query, search });
  }

  private toFilter(query: AdminUserListQuery): UserFilter {
    const filter: UserFilter = {};
    const clauses: UserFilterClause[] = [];

    if (query.status) filter.status = query.status;
    if (query.deletion) {
      filter.isDeleted = query.deletion === AdminUserDeletionFilter.DELETED;
    }
    if (query.restriction === AdminUserRestrictionFilter.NONE) {
      clauses.push({
        $or: [{ restriction: null }, { restriction: { $exists: false } }],
      });
    } else if (query.restriction) {
      filter['restriction.type'] =
        query.restriction === AdminUserRestrictionFilter.TEMPORARY_SUSPENSION
          ? UserRestrictionType.TEMPORARY_SUSPENSION
          : UserRestrictionType.INDEFINITE_BAN;
    }

    if (query.loginLock === AdminUserLoginLockFilter.LOCKED) {
      filter.lockedUntil = { $gt: new Date() };
    } else if (query.loginLock === AdminUserLoginLockFilter.UNLOCKED) {
      clauses.push({
        $or: [
          { lockedUntil: null },
          { lockedUntil: { $exists: false } },
          { lockedUntil: { $lte: new Date() } },
        ],
      });
    }

    if (query.search) clauses.push(this.toIdentityFilter(query.search));
    if (clauses.length > 0) filter.$and = clauses;

    return filter;
  }

  private toIdentityFilter(search: string): UserFilterClause {
    if (isValidAdminUserPublicId(search)) return { publicId: search };
    if (search.includes('@')) return { email: normalizeAuthEmail(search) };
    if (PHONE_SEARCH_PATTERN.test(search)) {
      return { phone: search };
    }
    return { username: search };
  }

  private async loadSessionSummary(
    userId: Types.ObjectId,
  ): Promise<PublicUserSessionSummary> {
    const [summary] = await this.sessions
      .aggregate<StoredSessionSummary>([
        {
          $match: {
            userId,
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          },
        },
        {
          $group: {
            _id: '$userId',
            activeCount: { $sum: 1 },
            lastActiveAt: { $max: '$lastUsedAt' },
          },
        },
      ])
      .exec();

    return summary
      ? Object.freeze({
          activeCount: summary.activeCount,
          lastActiveAt: summary.lastActiveAt.toISOString(),
        })
      : Object.freeze({ activeCount: 0, lastActiveAt: null });
  }

  private async loadActivitySummary(
    userId: Types.ObjectId,
    userPublicId: string,
  ): Promise<PublicAdminUserActivitySummary> {
    const [reportCount, moderationActionCount] = await Promise.all([
      this.reports
        .countDocuments({ targetType: ReportTargetType.USER, targetId: userId })
        .exec(),
      this.auditEvents
        .countDocuments({
          action: { $in: USER_MODERATION_ACTIONS },
          outcome: AdminAuditOutcome.SUCCEEDED,
          'target.type': AdminAuditTargetType.USER,
          'target.publicId': userPublicId,
        })
        .exec(),
    ]);

    return Object.freeze({ reportCount, moderationActionCount });
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ tra cứu User quản trị tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
