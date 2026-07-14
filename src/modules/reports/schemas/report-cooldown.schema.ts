import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ReportTargetType } from './report.schema';

@Schema({ timestamps: true, collection: 'report_cooldowns' })
export class ReportCooldown extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ReportTargetType),
  })
  targetType!: ReportTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  nextAllowedAt!: Date;

  @Prop({ type: Types.ObjectId, ref: 'Report', default: null })
  lastReportId!: Types.ObjectId | null;
}

export const ReportCooldownSchema =
  SchemaFactory.createForClass(ReportCooldown);

ReportCooldownSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true },
);

ReportCooldownSchema.index({ nextAllowedAt: 1 }, { expireAfterSeconds: 0 });
