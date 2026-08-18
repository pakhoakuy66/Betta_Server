import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

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

  @Prop({ type: ReportTargetSnapshotSchema, default: {} })
  targetSnapshot!: ReportTargetSnapshot;

  @Prop({ type: String, default: '', trim: true, maxlength: 1000 })
  adminNote!: string;

  @Prop({ type: Date, default: null })
  terminalAt!: Date | null;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

export const ADMIN_USER_REPORT_COUNT_INDEX =
  'admin_user_report_count_v1' as const;

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
