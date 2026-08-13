import {
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCOUNT_QUERY_MAX_LIMIT,
  ADMIN_ACCOUNT_QUERY_MAX_PAGE,
  ADMIN_ACCOUNT_QUERY_SEARCH_PATTERN,
} from '../constants/admin-account-query.constants';
import {
  type AdminAccountListQuery,
  type AdminAccountPage,
  type PublicAdminSessionSummary,
  type PublicManagedAdminAccount,
} from '../interfaces/admin-account-query.interface';
import {
  type ManagedAdminAccountSource,
  toPublicManagedAdminAccount,
} from '../mappers/admin-account-management.mapper';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

const ACCOUNT_PROJECTION =
  '_id publicId email username displayName role status mfaStatus ' +
  'mustChangePassword lockedAt deletedAt deletionOrigin createdAt updatedAt +version';

type StoredSessionSummary = Readonly<{
  _id: Types.ObjectId;
  activeCount: number;
  lastActiveAt: Date;
}>;

type AccountFilter = {
  role?: AdminRole;
  status?: AdminAccountStatus;
  mfaStatus?: AdminMfaStatus;
  publicId?: string;
  $or?: Array<{ email: string } | { username: string }>;
};

@Injectable()
export class AdminAccountQueryService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly sessions: Model<AdminSession>,
  ) {}

  async list(query: AdminAccountListQuery): Promise<AdminAccountPage> {
    const normalized = this.normalizeQuery(query);
    const filter = this.toFilter(normalized);

    try {
      const records = await this.accounts
        .find(filter)
        .sort({ createdAt: -1, publicId: 1 })
        .skip((normalized.page - 1) * normalized.limit)
        .limit(normalized.limit + 1)
        .select(ACCOUNT_PROJECTION)
        .lean<ManagedAdminAccountSource[]>()
        .exec();
      const visible = records.slice(0, normalized.limit);
      const summaries = await this.loadSessionSummaries(
        visible.map((record) => record._id),
      );

      return Object.freeze({
        items: Object.freeze(
          visible.map((record) =>
            toPublicManagedAdminAccount(
              record,
              summaries.get(record._id.toHexString()) ?? this.emptySummary(),
            ),
          ),
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

  async detail(publicId: string): Promise<PublicManagedAdminAccount> {
    if (!isValidAdminPublicId(publicId)) {
      throw new TypeError('Admin public ID không hợp lệ');
    }

    try {
      const account = await this.accounts
        .findOne({ publicId })
        .select(ACCOUNT_PROJECTION)
        .lean<ManagedAdminAccountSource | null>()
        .exec();
      if (!account) {
        throw new NotFoundException('Không tìm thấy tài khoản quản trị');
      }

      const summaries = await this.loadSessionSummaries([account._id]);
      return toPublicManagedAdminAccount(
        account,
        summaries.get(account._id.toHexString()) ?? this.emptySummary(),
      );
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private normalizeQuery(query: AdminAccountListQuery): AdminAccountListQuery {
    const role = query.role;
    const status = query.status;
    const mfaStatus = query.mfaStatus;
    const search = query.search?.trim();

    if (
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      query.page > ADMIN_ACCOUNT_QUERY_MAX_PAGE ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > ADMIN_ACCOUNT_QUERY_MAX_LIMIT ||
      (role !== undefined && !Object.values(AdminRole).includes(role)) ||
      (status !== undefined &&
        !Object.values(AdminAccountStatus).includes(status)) ||
      (mfaStatus !== undefined &&
        !Object.values(AdminMfaStatus).includes(mfaStatus)) ||
      (search !== undefined && !ADMIN_ACCOUNT_QUERY_SEARCH_PATTERN.test(search))
    ) {
      throw new TypeError('Admin account query không hợp lệ');
    }

    return Object.freeze({
      page: query.page,
      limit: query.limit,
      role,
      status,
      mfaStatus,
      search,
    });
  }

  private toFilter(query: AdminAccountListQuery): AccountFilter {
    const filter: AccountFilter = {};
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    if (query.mfaStatus) filter.mfaStatus = query.mfaStatus;

    if (query.search) {
      if (isValidAdminPublicId(query.search)) {
        filter.publicId = query.search;
      } else {
        const identity = normalizeAuthEmail(query.search);
        filter.$or = [{ email: identity }, { username: identity }];
      }
    }
    return filter;
  }

  private async loadSessionSummaries(
    accountIds: readonly Types.ObjectId[],
  ): Promise<ReadonlyMap<string, PublicAdminSessionSummary>> {
    if (accountIds.length === 0) return new Map();

    const records = await this.sessions
      .aggregate<StoredSessionSummary>([
        {
          $match: {
            adminAccountId: { $in: accountIds },
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          },
        },
        {
          $group: {
            _id: '$adminAccountId',
            activeCount: { $sum: 1 },
            lastActiveAt: { $max: '$lastUsedAt' },
          },
        },
      ])
      .exec();

    return new Map(
      records.map((record) => [
        record._id.toHexString(),
        Object.freeze({
          activeCount: record.activeCount,
          lastActiveAt: record.lastActiveAt.toISOString(),
        }),
      ]),
    );
  }

  private emptySummary(): PublicAdminSessionSummary {
    return Object.freeze({ activeCount: 0, lastActiveAt: null });
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ tra cứu tài khoản quản trị tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
