import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  ADMIN_SYSTEM_REPORT_QUEUE_ASSIGNEE_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_CREATED_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SLA_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_FILTERED_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SLA_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX,
  ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX,
  buildReportQueueMetadata,
  ReportQueuePriority,
} from '../constants/report-queue.constants';
import { generateSystemReportPublicId } from '../utils/generate-system-report-public-id';
import {
  ReportRetentionHold,
  ReportRetentionHoldSchema,
  RetentionCleanupStatus,
} from './report-retention.schema';

export { RetentionCleanupStatus } from './report-retention.schema';

export enum SystemReportStatus {
  PENDING = 'pending',
  INVESTIGATING = 'investigating',
  FIXED = 'fixed',
  CLOSED = 'closed',
}

export enum SystemReportSource {
  USER_AUTHENTICATED = 'USER_AUTHENTICATED',
  AUTH_PUBLIC = 'AUTH_PUBLIC',
}

export enum SystemReportType {
  SYSTEM_ISSUE = 'SYSTEM_ISSUE',
  ACCOUNT_ACCESS = 'ACCOUNT_ACCESS',
}

@Schema({ _id: false })
export class SystemReportEvidence {
  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: String, required: true })
  publicId!: string;
}

export const SystemReportEvidenceSchema =
  SchemaFactory.createForClass(SystemReportEvidence);

@Schema({
  timestamps: true,
  collection: 'system_reports',
})
export class SystemReport extends Document {
  @Prop({ type: String, default: null })
  publicId!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  reporterId!: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(SystemReportSource),
    default: SystemReportSource.USER_AUTHENTICATED,
  })
  source!: SystemReportSource;

  @Prop({
    type: String,
    enum: Object.values(SystemReportType),
    default: SystemReportType.SYSTEM_ISSUE,
  })
  reportType!: SystemReportType;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: String, default: null, select: false })
  encryptedContactEmail!: string | null;

  @Prop({ type: String, default: null, maxlength: 320 })
  contactEmailMasked!: string | null;

  @Prop({ type: String, default: null, select: false })
  contactLookupHmac!: string | null;

  @Prop({ type: String, default: null, select: false })
  encryptedAccountIdentifier!: string | null;

  @Prop({ type: String, default: null, select: false })
  requestFingerprintHmac!: string | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  correlationId!: string | null;

  @Prop({ type: Number, default: 0, min: 0 })
  version!: number;

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

  @Prop({ type: String, required: true, trim: true, maxlength: 2000 })
  description!: string;

  @Prop({ type: String, required: true })
  descriptionHash!: string;

  @Prop({ type: String, required: true })
  dedupeKey!: string;

  @Prop({ type: [SystemReportEvidenceSchema], default: [] })
  evidenceImages!: SystemReportEvidence[];

  @Prop({
    type: String,
    default: SystemReportStatus.PENDING,
    enum: Object.values(SystemReportStatus),
    index: true,
  })
  status!: SystemReportStatus;

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

  /**
   * Point-of-no-return fence cho Cloudinary deletion. Worker không được
   * reclaim một lease đã đi qua mốc này; trạng thái mơ hồ phải manual review.
   */
  @Prop({ type: Date, default: null, select: false })
  retentionDestructiveStartedAt!: Date | null;

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

export const SystemReportSchema = SchemaFactory.createForClass(SystemReport);

SystemReportSchema.pre('validate', function () {
  const createdAt = this.createdAt ?? new Date();
  const metadata = buildReportQueueMetadata(createdAt, this.priority);
  this.publicId ??= generateSystemReportPublicId();
  this.triageDueAt ??= metadata.triageDueAt;
  this.decisionDueAt ??= metadata.decisionDueAt;
});

SystemReportSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: { $type: 'string' },
    },
  },
);

SystemReportSchema.index(
  { publicId: 1 },
  {
    unique: true,
    partialFilterExpression: { publicId: { $type: 'string' } },
  },
);
SystemReportSchema.index({
  source: 1,
  reportType: 1,
  status: 1,
  createdAt: -1,
});
SystemReportSchema.index(
  { requestFingerprintHmac: 1, createdAt: -1 },
  { partialFilterExpression: { requestFingerprintHmac: { $type: 'string' } } },
);

SystemReportSchema.index({ reporterId: 1, createdAt: -1 });
SystemReportSchema.index({ reporterId: 1, descriptionHash: 1, createdAt: -1 });
SystemReportSchema.index({ status: 1, createdAt: -1 });
SystemReportSchema.index({ status: 1, terminalAt: 1 });
SystemReportSchema.index({
  retentionCleanupStatus: 1,
  retentionLockedUntil: 1,
  retentionDestructiveStartedAt: 1,
  retentionAttempts: 1,
  terminalAt: 1,
});
SystemReportSchema.index({
  'retentionHold.expiresAt': 1,
  terminalAt: 1,
  evidencePurgedAt: 1,
});

SystemReportSchema.index(
  { createdAt: -1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_CREATED_INDEX },
);
SystemReportSchema.index(
  { status: 1, reportType: 1, priority: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_FILTERED_INDEX },
);
SystemReportSchema.index(
  { assigneePublicId: 1, status: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_ASSIGNEE_INDEX },
);
SystemReportSchema.index(
  { triageDueAt: 1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SORT_INDEX },
);

SystemReportSchema.index(
  { decisionDueAt: 1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SORT_INDEX },
);
SystemReportSchema.index(
  { status: 1, triageDueAt: 1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_TRIAGE_SLA_INDEX },
);
SystemReportSchema.index(
  { status: 1, decisionDueAt: 1, publicId: 1 },
  { name: ADMIN_SYSTEM_REPORT_QUEUE_DECISION_SLA_INDEX },
);
