import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';
import { ADMIN_LIFECYCLE_HASH_PATTERN } from '../constants/admin-lifecycle.constants';
import { AdminReportQueueStatus } from '../constants/admin-report-queue.constants';
import {
  ADMIN_REPORT_PUBLIC_ID_PATTERN,
  AdminReportAssignmentKind,
  AdminReportAssignmentOperation,
  AdminReportAssignmentRequestState,
} from '../constants/admin-report-assignment.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_REPORT_ASSIGNMENT_REQUEST_COLLECTION =
  'admin_report_assignment_requests' as const;
export const ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_INDEX =
  'admin_report_assignment_idempotency_unique' as const;
export const ADMIN_REPORT_ASSIGNMENT_TTL_INDEX =
  'admin_report_assignment_idempotency_expiry_ttl' as const;

@Schema({
  collection: ADMIN_REPORT_ASSIGNMENT_REQUEST_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminReportAssignmentRequest {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_LIFECYCLE_HASH_PATTERN,
  })
  idempotencyHash!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_LIFECYCLE_HASH_PATTERN,
  })
  requestFingerprint!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  actorPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_SESSION_PUBLIC_ID_PATTERN,
  })
  actorSessionPublicId!: string;

  @Prop({
    type: Types.ObjectId,
    required: true,
    immutable: true,
    select: false,
  })
  targetReportId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_REPORT_PUBLIC_ID_PATTERN,
  })
  targetPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(AdminReportAssignmentOperation),
  })
  operation!: AdminReportAssignmentOperation;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AdminReportAssignmentRequestState),
  })
  state!: AdminReportAssignmentRequestState;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(AdminReportAssignmentKind),
  })
  resultKind!: AdminReportAssignmentKind;

  @Prop({
    type: String,
    default: null,
    enum: Object.values(AdminReportQueueStatus),
  })
  resultStatus!: AdminReportQueueStatus | null;

  @Prop({
    type: String,
    default: null,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  resultAssigneePublicId!: string | null;

  @Prop({ type: Date, default: null })
  resultAssignedAt!: Date | null;

  @Prop({ type: Number, default: null, min: 0 })
  resultVersion!: number | null;

  @Prop({ type: Date, default: null })
  resultUpdatedAt!: Date | null;

  @Prop({ type: Date, required: true, immutable: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminReportAssignmentRequestDocument =
  HydratedDocument<AdminReportAssignmentRequest>;
export const AdminReportAssignmentRequestSchema = SchemaFactory.createForClass(
  AdminReportAssignmentRequest,
);

AdminReportAssignmentRequestSchema.index(
  { idempotencyHash: 1 },
  { name: ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_INDEX, unique: true },
);
AdminReportAssignmentRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  { name: ADMIN_REPORT_ASSIGNMENT_TTL_INDEX, expireAfterSeconds: 0 },
);
