import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  ObjectId,
} from 'mongodb';
import {
  buildReportQueueMetadata,
  REPORT_PUBLIC_ID_PATTERN,
  ReportQueuePriority,
} from '../constants/report-queue.constants';
import { generateReportPublicId } from '../utils/generate-report-public-id';
import {
  generateSystemReportPublicId,
  isSystemReportPublicId,
} from '../utils/generate-system-report-public-id';

export const REPORT_QUEUE_MIGRATION_DEFAULT_BATCH_SIZE = 250;
export const REPORT_QUEUE_MIGRATION_MAX_BATCH_SIZE = 1_000;

export type ReportQueueMigrationDocument = Document & {
  _id: ObjectId;
  publicId?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  targetSnapshot?: { publicId?: unknown };
  priority?: unknown;
  assigneePublicId?: unknown;
  assignedAt?: unknown;
  triageDueAt?: unknown;
  decisionDueAt?: unknown;
  version?: unknown;
  createdAt?: unknown;
};

export type ReportQueueMigrationOptions = Readonly<{
  execute: boolean;
  batchSize: number;
  now?: Date;
}>;

export type ReportQueueMigrationResult = Readonly<{
  execute: boolean;
  reportsScanned: number;
  systemReportsScanned: number;
  reportsPlanned: number;
  systemReportsPlanned: number;
  updated: number;
  hasMore: boolean;
}>;

type ReportQueueMigrationCollections = Readonly<{
  reports: Collection<ReportQueueMigrationDocument>;
  systemReports: Collection<ReportQueueMigrationDocument>;
  users: Collection<Document>;
}>;

const needsMigration = {
  $or: [
    { publicId: { $not: { $type: 'string' } } },
    { priority: { $not: { $in: Object.values(ReportQueuePriority) } } },
    { triageDueAt: { $not: { $type: 'date' } } },
    { decisionDueAt: { $not: { $type: 'date' } } },
    { version: { $not: { $type: 'number' } } },
  ],
};

const asCreatedAt = (
  document: ReportQueueMigrationDocument,
  now: Date,
): Date => {
  if (document.createdAt instanceof Date) return document.createdAt;
  return document._id.getTimestamp?.() ?? now;
};

const buildSet = (
  document: ReportQueueMigrationDocument,
  publicId: string,
  now: Date,
): Record<string, unknown> => {
  const priority =
    document.priority === ReportQueuePriority.P0
      ? ReportQueuePriority.P0
      : ReportQueuePriority.STANDARD;
  const metadata = buildReportQueueMetadata(
    asCreatedAt(document, now),
    priority,
  );
  const set: Record<string, unknown> = {};

  if (document.publicId !== publicId) set.publicId = publicId;
  if (document.priority !== priority) set.priority = priority;
  if (!(document.triageDueAt instanceof Date)) {
    set.triageDueAt = metadata.triageDueAt;
  }
  if (!(document.decisionDueAt instanceof Date)) {
    set.decisionDueAt = metadata.decisionDueAt;
  }
  if (typeof document.version !== 'number') set.version = 0;
  if (!Object.prototype.hasOwnProperty.call(document, 'assigneePublicId')) {
    set.assigneePublicId = null;
  }
  if (!Object.prototype.hasOwnProperty.call(document, 'assignedAt')) {
    set.assignedAt = null;
  }
  return set;
};

const loadUserPublicIds = async (
  reports: readonly ReportQueueMigrationDocument[],
  users: Collection<Document>,
): Promise<ReadonlyMap<string, string>> => {
  const targetIds = reports
    .filter(
      (report) =>
        report.targetType === 'USER' &&
        report.targetId instanceof ObjectId &&
        typeof report.targetSnapshot?.publicId !== 'string',
    )
    .map((report) => report.targetId as ObjectId);
  if (targetIds.length === 0) return new Map();

  const rows = await users
    .find({ _id: { $in: targetIds } }, { projection: { _id: 1, publicId: 1 } })
    .toArray();
  return new Map(
    rows
      .filter((row) => typeof row.publicId === 'string')
      .map((row) => [String(row._id), row.publicId as string]),
  );
};

const buildReportOperations = async (
  documents: readonly ReportQueueMigrationDocument[],
  users: Collection<Document>,
  now: Date,
): Promise<AnyBulkWriteOperation<ReportQueueMigrationDocument>[]> => {
  const userPublicIds = await loadUserPublicIds(documents, users);
  return documents.map((document) => {
    const publicId =
      typeof document.publicId === 'string' &&
      REPORT_PUBLIC_ID_PATTERN.test(document.publicId)
        ? document.publicId
        : generateReportPublicId();
    const set = buildSet(document, publicId, now);
    if (
      document.targetType === 'USER' &&
      document.targetId instanceof ObjectId &&
      typeof document.targetSnapshot?.publicId !== 'string'
    ) {
      const targetPublicId = userPublicIds.get(String(document.targetId));
      if (targetPublicId) set['targetSnapshot.publicId'] = targetPublicId;
    }
    return {
      updateOne: {
        filter: { _id: document._id },
        update: { $set: set },
      },
    };
  });
};

const buildSystemOperations = (
  documents: readonly ReportQueueMigrationDocument[],
  now: Date,
): AnyBulkWriteOperation<ReportQueueMigrationDocument>[] =>
  documents.map((document) => {
    const publicId = isSystemReportPublicId(document.publicId)
      ? document.publicId
      : generateSystemReportPublicId();
    return {
      updateOne: {
        filter: { _id: document._id },
        update: { $set: buildSet(document, publicId, now) },
      },
    };
  });

export const migrateReportQueueMetadata = async (
  collections: ReportQueueMigrationCollections,
  options: ReportQueueMigrationOptions,
): Promise<ReportQueueMigrationResult> => {
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > REPORT_QUEUE_MIGRATION_MAX_BATCH_SIZE
  ) {
    throw new TypeError('batchSize không hợp lệ');
  }

  const now = options.now ?? new Date();
  const [reports, systemReports] = await Promise.all([
    collections.reports
      .find(needsMigration)
      .sort({ _id: 1 })
      .limit(options.batchSize + 1)
      .toArray(),
    collections.systemReports
      .find(needsMigration)
      .sort({ _id: 1 })
      .limit(options.batchSize + 1)
      .toArray(),
  ]);
  const reportBatch = reports.slice(0, options.batchSize);
  const systemBatch = systemReports.slice(0, options.batchSize);
  const [reportOperations, systemOperations] = await Promise.all([
    buildReportOperations(reportBatch, collections.users, now),
    Promise.resolve(buildSystemOperations(systemBatch, now)),
  ]);

  let updated = 0;
  if (options.execute) {
    const results = await Promise.all([
      reportOperations.length
        ? collections.reports.bulkWrite(reportOperations, { ordered: false })
        : Promise.resolve(null),
      systemOperations.length
        ? collections.systemReports.bulkWrite(systemOperations, {
            ordered: false,
          })
        : Promise.resolve(null),
    ]);
    updated = results.reduce(
      (sum, result) => sum + (result?.modifiedCount ?? 0),
      0,
    );
  }

  return Object.freeze({
    execute: options.execute,
    reportsScanned: reportBatch.length,
    systemReportsScanned: systemBatch.length,
    reportsPlanned: reportOperations.length,
    systemReportsPlanned: systemOperations.length,
    updated,
    hasMore:
      reports.length > options.batchSize ||
      systemReports.length > options.batchSize,
  });
};
