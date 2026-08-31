import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type SortOrder, Types } from 'mongoose';
import {
  type CanonicalModerationReasonCode,
  REPORT_REASON_CODES,
} from '../../../common/moderation/moderation-reason.constants';
import { Post } from '../../posts/schemas/post.schema';
import { ACCESS_SUPPORT_CATEGORIES } from '../../reports/constants/access-support.constants';
import { ReportQueuePriority } from '../../reports/constants/report-queue.constants';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportSource,
  SystemReportStatus,
  SystemReportType,
} from '../../reports/schemas/system-report.schema';
import { User } from '../../users/schemas/user.schema';
import {
  ADMIN_REPORT_QUEUE_UNASSIGNED,
  ADMIN_STATUS_TO_REPORT,
  ADMIN_STATUS_TO_SYSTEM_REPORT,
  AdminReportQueueSlaFilter,
  AdminReportQueueSort,
  AdminReportQueueStatus,
  AdminReportQueueType,
  isSystemQueueType,
  isUserContentQueueType,
  REPORT_STATUS_TO_ADMIN,
  SYSTEM_REPORT_STATUS_TO_ADMIN,
  toReportTargetType,
  toSystemReportType,
} from '../constants/admin-report-queue.constants';
import {
  type AdminReportQueuePage,
  type AdminReportQueueQuery,
  AdminReportTargetAvailability,
  type PublicAdminReportQueueItem,
} from '../interfaces/admin-report-queue.interface';

type MongoFilter = Record<string, unknown>;

type TargetSnapshot = Readonly<{
  publicId?: string;
  username?: string;
  authorUsername?: string;
  targetStatus?: string;
  expireAt?: Date | null;
}>;

type StoredReportQueueRecord = Readonly<{
  kind: 'REPORT';
  publicId: string;
  targetId: Types.ObjectId;
  targetType: ReportTargetType;
  reasonCode: CanonicalModerationReasonCode | null;
  reasonGroup: ReportReasonGroup;
  status: ReportStatus;
  priority: ReportQueuePriority;
  assigneePublicId: string | null;
  assignedAt: Date | null;
  triageDueAt: Date;
  decisionDueAt: Date;
  targetSnapshot: TargetSnapshot;
  version: number;
  createdAt: Date;
  terminalAt: Date | null;
}>;

type StoredSystemReportQueueRecord = Readonly<{
  kind: 'SYSTEM_REPORT';
  publicId: string;
  source: SystemReportSource;
  reportType: SystemReportType;
  category: string | null;
  contactEmailMasked: string | null;
  status: SystemReportStatus;
  priority: ReportQueuePriority;
  assigneePublicId: string | null;
  assignedAt: Date | null;
  triageDueAt: Date;
  decisionDueAt: Date;
  version: number;
  createdAt: Date;
  terminalAt: Date | null;
}>;

type StoredQueueRecord =
  | StoredReportQueueRecord
  | StoredSystemReportQueueRecord;

type TargetStateMaps = Readonly<{
  users: ReadonlyMap<string, boolean>;
  posts: ReadonlyMap<string, Date | null>;
}>;

const REPORT_PROJECTION = Object.freeze({
  _id: 0,
  publicId: 1,
  targetId: 1,
  targetType: 1,
  reasonCode: 1,
  reasonGroup: 1,
  status: 1,
  priority: 1,
  assigneePublicId: 1,
  assignedAt: 1,
  triageDueAt: 1,
  decisionDueAt: 1,
  'targetSnapshot.publicId': 1,
  'targetSnapshot.username': 1,
  'targetSnapshot.authorUsername': 1,
  'targetSnapshot.targetStatus': 1,
  'targetSnapshot.expireAt': 1,
  version: 1,
  createdAt: 1,
  terminalAt: 1,
});

const SYSTEM_REPORT_PROJECTION = Object.freeze({
  _id: 0,
  publicId: 1,
  source: 1,
  reportType: 1,
  category: 1,
  contactEmailMasked: 1,
  status: 1,
  priority: 1,
  assigneePublicId: 1,
  assignedAt: 1,
  triageDueAt: 1,
  decisionDueAt: 1,
  version: 1,
  createdAt: 1,
  terminalAt: 1,
});

const REPORT_REASON_VALUES = new Set<string>([
  ...REPORT_REASON_CODES,
  ...Object.values(ReportReasonGroup),
]);
const CANONICAL_REPORT_REASON_VALUES = new Set<string>(REPORT_REASON_CODES);
const SYSTEM_REPORT_REASON_VALUES = new Set<string>([
  ...ACCESS_SUPPORT_CATEGORIES,
  SystemReportType.SYSTEM_ISSUE,
]);
const ACCESS_SUPPORT_TYPE = AdminReportQueueType.ACCOUNT_ACCESS;

@Injectable()
export class AdminReportQueueService {
  constructor(
    @InjectModel(Report.name)
    private readonly reports: Model<Report>,
    @InjectModel(SystemReport.name)
    private readonly systemReports: Model<SystemReport>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    @InjectModel(Post.name)
    private readonly posts: Model<Post>,
  ) {}

  async list(query: AdminReportQueueQuery): Promise<AdminReportQueuePage> {
    this.assertDateRange(query);
    const now = new Date();
    const offset = (query.page - 1) * query.limit;
    const branchLimit = offset + query.limit + 1;
    const sort = this.mongoSort(query.sort);

    try {
      const [reportRecords, systemRecords] = await Promise.all([
        this.shouldQueryReports(query.type)
          ? this.findReports(query, now, sort, branchLimit)
          : Promise.resolve([]),
        this.shouldQuerySystemReports(query.type)
          ? this.findSystemReports(query, now, sort, branchLimit)
          : Promise.resolve([]),
      ]);
      const merged = [...reportRecords, ...systemRecords].sort(
        this.comparator(query.sort),
      );
      const pageRecords = merged.slice(offset, offset + query.limit + 1);
      const hasMore = pageRecords.length > query.limit;
      const selected = pageRecords.slice(0, query.limit);
      const targetStates = await this.loadTargetStates(selected);

      return Object.freeze({
        items: Object.freeze(
          selected.map((record) =>
            this.toPublicItem(record, now, targetStates),
          ),
        ),
        pagination: Object.freeze({
          page: query.page,
          limit: query.limit,
          hasMore,
        }),
      });
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(
        'Không thể tải hàng đợi báo cáo lúc này',
      );
    }
  }

  private async findReports(
    query: AdminReportQueueQuery,
    now: Date,
    sort: Readonly<Record<string, SortOrder>>,
    limit: number,
  ): Promise<StoredReportQueueRecord[]> {
    const match = this.reportMatch(query, now);
    if (!match) return [];

    const documents = await this.reports
      .find(match as never, REPORT_PROJECTION)
      .sort(sort)
      .limit(limit)
      .lean<Omit<StoredReportQueueRecord, 'kind'>[]>()
      .exec();

    return documents.map((document) =>
      Object.freeze({ ...document, kind: 'REPORT' as const }),
    );
  }

  private async findSystemReports(
    query: AdminReportQueueQuery,
    now: Date,
    sort: Readonly<Record<string, SortOrder>>,
    limit: number,
  ): Promise<StoredSystemReportQueueRecord[]> {
    const match = this.systemReportMatch(query, now);
    if (!match) return [];

    const documents = await this.systemReports
      .find(match as never, SYSTEM_REPORT_PROJECTION)
      .sort(sort)
      .limit(limit)
      .lean<Omit<StoredSystemReportQueueRecord, 'kind'>[]>()
      .exec();

    return documents.map((document) =>
      Object.freeze({ ...document, kind: 'SYSTEM_REPORT' as const }),
    );
  }

  private reportMatch(
    query: AdminReportQueueQuery,
    now: Date,
  ): MongoFilter | null {
    if (query.reason && !REPORT_REASON_VALUES.has(query.reason)) return null;

    const clauses: MongoFilter[] = [
      {
        publicId: { $type: 'string' },
        triageDueAt: { $type: 'date' },
        decisionDueAt: { $type: 'date' },
      },
    ];

    if (isUserContentQueueType(query.type)) {
      clauses.push({ targetType: toReportTargetType(query.type) });
    }
    if (query.status) {
      clauses.push({ status: ADMIN_STATUS_TO_REPORT[query.status] });
    }
    if (query.reason) {
      clauses.push(
        CANONICAL_REPORT_REASON_VALUES.has(query.reason)
          ? { reasonCode: query.reason }
          : { reasonGroup: query.reason },
      );
    }
    if (query.priority) clauses.push({ priority: query.priority });
    this.addCommonMatch(clauses, query);
    this.addReportSlaMatch(clauses, query.sla, now);

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private systemReportMatch(
    query: AdminReportQueueQuery,
    now: Date,
  ): MongoFilter | null {
    if (query.reason && !SYSTEM_REPORT_REASON_VALUES.has(query.reason)) {
      return null;
    }

    const clauses: MongoFilter[] = [
      {
        publicId: { $type: 'string' },
        triageDueAt: { $type: 'date' },
        decisionDueAt: { $type: 'date' },
      },
    ];

    if (isSystemQueueType(query.type)) {
      clauses.push({ reportType: toSystemReportType(query.type) });
    }
    if (query.status) {
      clauses.push({ status: ADMIN_STATUS_TO_SYSTEM_REPORT[query.status] });
    }
    if (query.reason === SystemReportType.SYSTEM_ISSUE) {
      clauses.push({ reportType: SystemReportType.SYSTEM_ISSUE });
    } else if (query.reason) {
      clauses.push({
        reportType: SystemReportType.ACCOUNT_ACCESS,
        category: query.reason,
      });
    }
    if (query.priority) clauses.push({ priority: query.priority });
    this.addCommonMatch(clauses, query);
    this.addSystemReportSlaMatch(clauses, query.sla, now);

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private addCommonMatch(
    clauses: MongoFilter[],
    query: AdminReportQueueQuery,
  ): void {
    if (query.assignee === ADMIN_REPORT_QUEUE_UNASSIGNED) {
      clauses.push({
        $or: [
          { assigneePublicId: null },
          { assigneePublicId: { $exists: false } },
        ],
      });
    } else if (query.assignee) {
      clauses.push({
        assigneePublicId: query.assignee,
      });
    }

    const createdAt: Record<string, Date> = {};
    if (query.createdFrom) createdAt.$gte = new Date(query.createdFrom);
    if (query.createdTo) createdAt.$lte = new Date(query.createdTo);
    if (Object.keys(createdAt).length > 0) {
      clauses.push({ createdAt });
    }
  }

  private addReportSlaMatch(
    clauses: MongoFilter[],
    sla: AdminReportQueueSlaFilter | undefined,
    now: Date,
  ): void {
    if (!sla) return;
    const breached: MongoFilter = {
      $or: [
        { status: ReportStatus.PENDING, triageDueAt: { $lt: now } },
        { status: ReportStatus.REVIEWING, decisionDueAt: { $lt: now } },
      ],
    };
    clauses.push(
      sla === AdminReportQueueSlaFilter.BREACHED
        ? breached
        : { $nor: [breached] },
    );
  }

  private addSystemReportSlaMatch(
    clauses: MongoFilter[],
    sla: AdminReportQueueSlaFilter | undefined,
    now: Date,
  ): void {
    if (!sla) return;
    const breached: MongoFilter = {
      $or: [
        {
          status: SystemReportStatus.PENDING,
          triageDueAt: { $lt: now },
        },
        {
          status: SystemReportStatus.INVESTIGATING,
          decisionDueAt: { $lt: now },
        },
      ],
    };
    clauses.push(
      sla === AdminReportQueueSlaFilter.BREACHED
        ? breached
        : { $nor: [breached] },
    );
  }

  private shouldQueryReports(type: AdminReportQueueType | undefined): boolean {
    return !type || isUserContentQueueType(type);
  }

  private shouldQuerySystemReports(
    type: AdminReportQueueType | undefined,
  ): boolean {
    return !type || isSystemQueueType(type);
  }

  private mongoSort(
    sort: AdminReportQueueSort,
  ): Readonly<Record<string, SortOrder>> {
    switch (sort) {
      case AdminReportQueueSort.CREATED_AT_ASC:
        return Object.freeze({ createdAt: 1, publicId: 1 });
      case AdminReportQueueSort.TRIAGE_DUE_ASC:
        return Object.freeze({ triageDueAt: 1, publicId: 1 });
      case AdminReportQueueSort.DECISION_DUE_ASC:
        return Object.freeze({ decisionDueAt: 1, publicId: 1 });
      case AdminReportQueueSort.CREATED_AT_DESC:
      default:
        return Object.freeze({ createdAt: -1, publicId: 1 });
    }
  }

  private comparator(
    sort: AdminReportQueueSort,
  ): (left: StoredQueueRecord, right: StoredQueueRecord) => number {
    const field =
      sort === AdminReportQueueSort.TRIAGE_DUE_ASC
        ? 'triageDueAt'
        : sort === AdminReportQueueSort.DECISION_DUE_ASC
          ? 'decisionDueAt'
          : 'createdAt';
    const direction = sort === AdminReportQueueSort.CREATED_AT_DESC ? -1 : 1;

    return (left, right) => {
      const delta = left[field].getTime() - right[field].getTime();

      if (delta !== 0) return delta * direction;
      if (left.publicId === right.publicId) return 0;

      // Public IDs are ASCII. This matches MongoDB's default binary collation.
      return left.publicId < right.publicId ? -1 : 1;
    };
  }

  private async loadTargetStates(
    records: readonly StoredQueueRecord[],
  ): Promise<TargetStateMaps> {
    const userIds: Types.ObjectId[] = [];
    const postIds: Types.ObjectId[] = [];
    for (const record of records) {
      if (record.kind !== 'REPORT') continue;
      if (record.targetType === ReportTargetType.USER) {
        userIds.push(record.targetId);
      } else {
        postIds.push(record.targetId);
      }
    }

    const [users, posts] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : this.users
            .find({ _id: { $in: userIds } }, { _id: 1, isDeleted: 1 })
            .lean<Array<{ _id: Types.ObjectId; isDeleted: boolean }>>()
            .exec(),
      postIds.length === 0
        ? Promise.resolve([])
        : this.posts
            .find({ _id: { $in: postIds } }, { _id: 1, expireAt: 1 })
            .lean<Array<{ _id: Types.ObjectId; expireAt: Date | null }>>()
            .exec(),
    ]);

    return Object.freeze({
      users: new Map(
        users.map((user) => [user._id.toHexString(), user.isDeleted]),
      ),
      posts: new Map(
        posts.map((post) => [post._id.toHexString(), post.expireAt ?? null]),
      ),
    });
  }

  private toPublicItem(
    record: StoredQueueRecord,
    now: Date,
    states: TargetStateMaps,
  ): PublicAdminReportQueueItem {
    const status =
      record.kind === 'REPORT'
        ? REPORT_STATUS_TO_ADMIN[record.status]
        : SYSTEM_REPORT_STATUS_TO_ADMIN[record.status];
    const dueAt =
      status === AdminReportQueueStatus.PENDING
        ? record.triageDueAt
        : record.decisionDueAt;
    const isBreached =
      (status === AdminReportQueueStatus.PENDING ||
        status === AdminReportQueueStatus.REVIEWING) &&
      dueAt.getTime() < now.getTime();

    return Object.freeze({
      id: record.publicId,
      publicId: record.publicId,
      type: this.queueType(record),
      status,
      source: record.kind === 'REPORT' ? 'USER_REPORT' : record.source,
      reasonCode: this.reasonCode(record),
      priority: record.priority,
      assignee: Object.freeze({
        publicId: record.assigneePublicId ?? null,
        assignedAt: record.assignedAt?.toISOString() ?? null,
      }),
      target: this.target(record, now, states),
      ...(record.kind === 'SYSTEM_REPORT' &&
      record.reportType === SystemReportType.ACCOUNT_ACCESS
        ? {
            contact: Object.freeze({
              emailMasked: record.contactEmailMasked ?? null,
            }),
          }
        : {}),
      sla: Object.freeze({
        triageDueAt: record.triageDueAt.toISOString(),
        decisionDueAt: record.decisionDueAt.toISOString(),
        isBreached,
      }),
      version: record.version ?? 0,
      createdAt: record.createdAt.toISOString(),
      terminalAt: record.terminalAt?.toISOString() ?? null,
    });
  }

  private queueType(record: StoredQueueRecord): AdminReportQueueType {
    if (record.kind === 'REPORT') {
      return record.targetType === ReportTargetType.POST
        ? AdminReportQueueType.POST
        : AdminReportQueueType.USER;
    }
    return record.reportType === SystemReportType.ACCOUNT_ACCESS
      ? ACCESS_SUPPORT_TYPE
      : AdminReportQueueType.SYSTEM_ISSUE;
  }

  private reasonCode(record: StoredQueueRecord): string {
    if (record.kind === 'REPORT') {
      return record.reasonCode ?? record.reasonGroup;
    }
    return record.reportType === SystemReportType.ACCOUNT_ACCESS
      ? (record.category ?? 'OTHER_ACCOUNT_ACCESS_ISSUE')
      : SystemReportType.SYSTEM_ISSUE;
  }

  private target(
    record: StoredQueueRecord,
    now: Date,
    states: TargetStateMaps,
  ): PublicAdminReportQueueItem['target'] {
    if (record.kind === 'SYSTEM_REPORT') {
      return Object.freeze({
        publicId: null,
        username: null,
        availability: AdminReportTargetAvailability.NOT_APPLICABLE,
        expireAt: null,
      });
    }

    const key = record.targetId.toHexString();
    const snapshot = record.targetSnapshot ?? {};
    if (record.targetType === ReportTargetType.USER) {
      const deleted = states.users.get(key);
      return Object.freeze({
        publicId: snapshot.publicId || null,
        username: snapshot.username || null,
        availability:
          deleted === undefined
            ? AdminReportTargetAvailability.UNAVAILABLE
            : deleted
              ? AdminReportTargetAvailability.DELETED
              : AdminReportTargetAvailability.AVAILABLE,
        expireAt: null,
      });
    }

    const storedExpireAt = states.posts.get(key);
    const expireAt = storedExpireAt ?? snapshot.expireAt ?? null;
    const expired = Boolean(expireAt && expireAt.getTime() <= now.getTime());
    return Object.freeze({
      publicId: snapshot.publicId || null,
      username: snapshot.authorUsername || null,
      availability: expired
        ? AdminReportTargetAvailability.EXPIRED
        : states.posts.has(key)
          ? AdminReportTargetAvailability.AVAILABLE
          : AdminReportTargetAvailability.UNAVAILABLE,
      expireAt: expireAt?.toISOString() ?? null,
    });
  }

  private assertDateRange(query: AdminReportQueueQuery): void {
    if (
      query.createdFrom &&
      query.createdTo &&
      new Date(query.createdFrom).getTime() >
        new Date(query.createdTo).getTime()
    ) {
      throw new BadRequestException('createdFrom không được lớn hơn createdTo');
    }
  }
}
