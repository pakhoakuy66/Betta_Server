import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, type AnyBulkWriteOperation } from 'mongoose';
import {
  MODERATION_REASON_TAXONOMY_VERSION,
  REPORT_REASON_CODES,
} from '../../../common/moderation/moderation-reason.constants';
import {
  ADMIN_REPORT_QUEUE_ASSIGNEE_INDEX,
  ADMIN_REPORT_QUEUE_CREATED_INDEX,
  ADMIN_REPORT_QUEUE_DECISION_SLA_INDEX,
  ADMIN_REPORT_QUEUE_FILTERED_INDEX,
  ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX,
  ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX,
  ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX,
  buildReportQueueMetadata,
  ReportQueuePriority,
} from '../constants/report-queue.constants';
import { generateReportPublicId } from '../utils/generate-report-public-id';
import { REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE } from '../../admin/constants/admin-post-moderation-detail.constants';
import {
  ReportRetentionHold,
  ReportRetentionHoldSchema,
  RetentionCleanupStatus,
} from './report-retention.schema';

export enum ReportTargetType {
  POST = 'POST',
  USER = 'USER',
}

export enum ReportStatus {
  PENDING = 'pending',
  REVIEWING = 'reviewing',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

export enum ReportReasonGroup {
  VIOLATION_CONTENT = 'violation_content',
  INAPPROPRIATE_CONTENT = 'inappropriate_content',
  IMPERSONATION = 'impersonation',
}

@Schema({ _id: false })
export class ReportImageSnapshot {
  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: String, required: true })
  publicId!: string;
}

export const ReportImageSnapshotSchema =
  SchemaFactory.createForClass(ReportImageSnapshot);

@Schema({ _id: false })
export class ReportTargetSnapshot {
  // Report Post
  @Prop({ type: String, default: '' })
  publicId!: string;

  @Prop({ type: Types.ObjectId, default: null })
  authorId!: Types.ObjectId | null;

  @Prop({ type: String, default: '' })
  authorUsername!: string;

  @Prop({ type: String, default: '' })
  content!: string;

  @Prop({ type: [ReportImageSnapshotSchema], default: [] })
  images!: ReportImageSnapshot[];

  @Prop({ type: Date, default: null })
  createdAt!: Date | null;

  @Prop({ type: Date, default: null })
  expireAt!: Date | null;

  // Report User
  @Prop({ type: String, default: '' })
  username!: string;

  @Prop({ type: String, default: '' })
  fullname!: string;

  @Prop({ type: String, default: '' })
  avatar!: string;

  @Prop({ type: String, default: '' })
  bio!: string;

  @Prop({ type: String, default: '' })
  targetStatus!: string;
}

export const ReportTargetSnapshotSchema =
  SchemaFactory.createForClass(ReportTargetSnapshot);

@Schema({ timestamps: true })
export class Report extends Document {
  @Prop({ type: String, default: null })
  publicId!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporterId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ReportTargetType),
    index: true,
  })
  targetType!: ReportTargetType;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  targetId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ReportReasonGroup),
    default: ReportReasonGroup.VIOLATION_CONTENT,
    index: true,
  })
  reasonGroup!: ReportReasonGroup;

  @Prop({
    type: String,
    enum: REPORT_REASON_CODES,
    default: null,
    index: true,
  })
  reasonCode!: string | null;

  @Prop({
    type: Number,
    enum: [MODERATION_REASON_TAXONOMY_VERSION],
    default: null,
  })
  reasonTaxonomyVersion!: number | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  reasonDetail!: string;

  @Prop({ type: String, default: '', trim: true, maxlength: 1000 })
  description!: string;

  @Prop({
    type: String,
    default: ReportStatus.PENDING,
    enum: Object.values(ReportStatus),
    index: true,
  })
  status!: ReportStatus;

  @Prop({
    type: String,
    enum: Object.values(ReportQueuePriority),
    default: ReportQueuePriority.STANDARD,
  })
  priority!: ReportQueuePriority;

  @Prop({ type: String, default: null })
  assigneePublicId!: string | null;

  @Prop({ type: Date, default: null })
  assignedAt!: Date | null;

  @Prop({ type: Date, default: null })
  triageDueAt!: Date | null;

  @Prop({ type: Date, default: null })
  decisionDueAt!: Date | null;

  @Prop({ type: Number, default: 0, min: 0 })
  version!: number;

  @Prop({ type: ReportTargetSnapshotSchema, default: {}, immutable: true })
  targetSnapshot!: ReportTargetSnapshot;

  @Prop({ type: String, default: '', trim: true, maxlength: 1000 })
  adminNote!: string;

  @Prop({ type: Date, default: null })
  terminalAt!: Date | null;

  @Prop({
    type: String,
    enum: Object.values(RetentionCleanupStatus),
    default: RetentionCleanupStatus.PENDING,
  })
  retentionCleanupStatus!: RetentionCleanupStatus;

  @Prop({ type: Date, default: null })
  retentionLockedUntil!: Date | null;

  @Prop({ type: String, default: null })
  retentionLockToken!: string | null;

  @Prop({ type: Number, default: 0, min: 0 })
  retentionAttempts!: number;

  @Prop({ type: String, default: '', maxlength: 2000 })
  retentionLastError!: string;

  @Prop({ type: Date, default: null })
  evidencePurgedAt!: Date | null;

  @Prop({ type: Boolean, default: false })
  evidenceUnavailable!: boolean;

  @Prop({
    type: ReportRetentionHoldSchema,
    default: null,
    select: false,
  })
  retentionHold!: ReportRetentionHold | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

ReportSchema.pre('validate', function () {
  const createdAt = this.createdAt ?? new Date();
  const metadata = buildReportQueueMetadata(createdAt, this.priority);
  this.publicId ??= generateReportPublicId();
  this.triageDueAt ??= metadata.triageDueAt;
  this.decisionDueAt ??= metadata.decisionDueAt;
});

const immutableSnapshotError = (): Error =>
  new Error(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

const isTargetSnapshotPath = (value: unknown): boolean =>
  typeof value === 'string' &&
  (value === 'targetSnapshot' || value.startsWith('targetSnapshot.'));

const updateTouchesTargetSnapshot = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(updateTouchesTargetSnapshot);
  }
  if (typeof value !== 'object' || value === null) return false;

  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (isTargetSnapshotPath(key)) return true;
    /*
     * MongoDB update pipelines can remove fields without naming the removed
     * path as an object key. Fail closed for stages that can replace or reshape
     * the complete document because proving snapshot preservation is unsafe.
     */
    if (
      key === '$project' ||
      key === '$replaceRoot' ||
      key === '$replaceWith'
    ) {
      return true;
    }
    if (
      key === '$unset' &&
      ((typeof nested === 'string' && isTargetSnapshotPath(nested)) ||
        (Array.isArray(nested) && nested.some(isTargetSnapshotPath)))
    ) {
      return true;
    }
    if (
      key === '$rename' &&
      typeof nested === 'object' &&
      nested !== null &&
      Object.values(nested as Record<string, unknown>).some(
        isTargetSnapshotPath,
      )
    ) {
      return true;
    }
    if (updateTouchesTargetSnapshot(nested)) return true;
  }
  return false;
};

const bulkOperationTouchesTargetSnapshot = (
  operation: AnyBulkWriteOperation<any>,
): boolean => {
  if ('updateOne' in operation) {
    return updateTouchesTargetSnapshot(operation.updateOne.update);
  }

  if ('updateMany' in operation) {
    return updateTouchesTargetSnapshot(operation.updateMany.update);
  }

  /*
   * Query replaceOne/findOneAndReplace hiện đã bị chặn hoàn toàn.
   * Model.bulkWrite replaceOne phải giữ cùng invariant vì replacement có thể
   * loại bỏ hoặc thay thế snapshot mà không biểu diễn bằng dotted update path.
   */
  if ('replaceOne' in operation) {
    return true;
  }

  /*
   * insertOne được phép tạo Report mới cùng initial snapshot.
   * deleteOne/deleteMany không sửa nội dung snapshot của document còn tồn tại.
   */
  return false;
};

ReportSchema.pre('save', function rejectSnapshotDocumentMutation() {
  if (!this.isNew && this.isModified('targetSnapshot')) {
    throw immutableSnapshotError();
  }
});

const rejectSnapshotQueryMutation = function (
  this: Readonly<{ getUpdate: () => unknown }>,
): void {
  if (updateTouchesTargetSnapshot(this.getUpdate())) {
    throw immutableSnapshotError();
  }
};

ReportSchema.pre('updateOne', rejectSnapshotQueryMutation);
ReportSchema.pre('updateMany', rejectSnapshotQueryMutation);
ReportSchema.pre('findOneAndUpdate', rejectSnapshotQueryMutation);
ReportSchema.pre('replaceOne', () => {
  throw immutableSnapshotError();
});
ReportSchema.pre('findOneAndReplace', () => {
  throw immutableSnapshotError();
});

ReportSchema.pre(
  'bulkWrite',
  function rejectSnapshotBulkWriteMutation(operations): void {
    if (operations.some(bulkOperationTouchesTargetSnapshot)) {
      throw immutableSnapshotError();
    }
  },
);

export const ADMIN_USER_REPORT_COUNT_INDEX =
  'admin_user_report_count_v1' as const;

ReportSchema.index(
  { publicId: 1 },
  {
    unique: true,
    name: 'report_public_id_unique_v1',
    partialFilterExpression: { publicId: { $type: 'string' } },
  },
);

ReportSchema.index(
  { targetType: 1, targetId: 1 },
  { name: ADMIN_USER_REPORT_COUNT_INDEX },
);

ReportSchema.index({
  reporterId: 1,
  targetType: 1,
  targetId: 1,
  createdAt: -1,
});

ReportSchema.index({ reporterId: 1, createdAt: -1 });
ReportSchema.index({ targetType: 1, status: 1, createdAt: -1 });
ReportSchema.index({ status: 1, createdAt: -1 });
ReportSchema.index({ status: 1, terminalAt: 1 });
ReportSchema.index({
  retentionCleanupStatus: 1,
  retentionLockedUntil: 1,
  retentionAttempts: 1,
  terminalAt: 1,
});
ReportSchema.index({
  targetType: 1,
  targetId: 1,
  'retentionHold.expiresAt': 1,
  terminalAt: -1,
});

ReportSchema.index(
  { createdAt: -1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_CREATED_INDEX },
);
ReportSchema.index(
  { status: 1, targetType: 1, priority: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_FILTERED_INDEX },
);
ReportSchema.index(
  { triageDueAt: 1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_TRIAGE_SORT_INDEX },
);

ReportSchema.index(
  { decisionDueAt: 1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_DECISION_SORT_INDEX },
);
ReportSchema.index(
  { assigneePublicId: 1, status: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_ASSIGNEE_INDEX },
);
ReportSchema.index(
  { status: 1, triageDueAt: 1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_TRIAGE_SLA_INDEX },
);
ReportSchema.index(
  { status: 1, decisionDueAt: 1, publicId: 1 },
  { name: ADMIN_REPORT_QUEUE_DECISION_SLA_INDEX },
);
