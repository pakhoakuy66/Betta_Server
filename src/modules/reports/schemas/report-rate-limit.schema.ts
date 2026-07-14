import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true,
  collection: 'report_rate_limits',
})
export class ReportRateLimit extends Document {
  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  scope!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  ipHash!: string | null;

  @Prop({ type: Date, required: true })
  windowStart!: Date;

  @Prop({ type: Date, required: true })
  windowEnd!: Date;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  count!: number;

  @Prop({ type: [String], default: [] })
  targetKeys!: string[];

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export const ReportRateLimitSchema =
  SchemaFactory.createForClass(ReportRateLimit);

ReportRateLimitSchema.index({ key: 1 }, { unique: true });
ReportRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Chỉ giữ index này nếu cần điều tra abuse trong Atlas.
ReportRateLimitSchema.index({ scope: 1, windowStart: -1 });
