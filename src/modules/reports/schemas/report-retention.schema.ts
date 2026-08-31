import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum RetentionCleanupStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  FAILED = 'failed',
  CLEANED = 'cleaned',
  MANUAL_REVIEW = 'manual_review',
}

@Schema({ _id: false })
export class ReportRetentionHold {
  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 128,
  })
  owner!: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 500,
  })
  reason!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, required: true, default: () => new Date() })
  createdAt!: Date;
}

export const ReportRetentionHoldSchema =
  SchemaFactory.createForClass(ReportRetentionHold);
