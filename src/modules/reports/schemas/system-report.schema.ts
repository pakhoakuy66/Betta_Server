import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum SystemReportStatus {
  PENDING = 'pending',
  INVESTIGATING = 'investigating',
  FIXED = 'fixed',
  CLOSED = 'closed',
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
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporterId!: Types.ObjectId;

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
}

export const SystemReportSchema = SchemaFactory.createForClass(SystemReport);

SystemReportSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: { $type: 'string' },
    },
  },
);

SystemReportSchema.index({ reporterId: 1, createdAt: -1 });
SystemReportSchema.index({ reporterId: 1, descriptionHash: 1, createdAt: -1 });
SystemReportSchema.index({ status: 1, createdAt: -1 });
