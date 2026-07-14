import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { RECAP_TIMEZONE } from '../utils/recap-week.util';

export enum WeeklyRecapRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({
  timestamps: true,
  collection: 'weekly_recap_runs',
})
export class WeeklyRecapRun extends Document {
  @Prop({ type: Number, required: true })
  year!: number;

  @Prop({ type: Number, required: true })
  weekNumber!: number;

  @Prop({ type: String, required: true })
  weekKey!: string;

  @Prop({ type: Date, required: true })
  weekStart!: Date;

  @Prop({ type: Date, required: true })
  weekEnd!: Date;

  @Prop({ type: String, required: true, default: RECAP_TIMEZONE })
  timezone!: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(WeeklyRecapRunStatus),
    default: WeeklyRecapRunStatus.PENDING,
    index: true,
  })
  status!: WeeklyRecapRunStatus;

  @Prop({ type: Date, default: null })
  startedAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  @Prop({ type: Date, default: null })
  lockedUntil!: Date | null;

  @Prop({ type: Number, default: 0 })
  attemptCount!: number;

  @Prop({ type: Number, default: 0 })
  processed!: number;

  @Prop({ type: Number, default: 0 })
  upserted!: number;

  @Prop({ type: Number, default: 0 })
  modified!: number;

  @Prop({ type: Number, default: 0 })
  matched!: number;

  @Prop({ type: String, default: '' })
  lastError!: string;

  @Prop({ type: Date, default: null })
  notificationsCreatedAt!: Date | null;

  @Prop({ type: Number, default: 0 })
  notificationsAttemptedCount!: number;

  @Prop({ type: Number, default: 0 })
  notificationsCreatedCount!: number;

  @Prop({ type: Number, default: 0 })
  notificationsMatchedCount!: number;

  @Prop({ type: String, default: '' })
  notificationLastError!: string;
}

export const WeeklyRecapRunSchema =
  SchemaFactory.createForClass(WeeklyRecapRun);

WeeklyRecapRunSchema.index({ weekKey: 1, timezone: 1 }, { unique: true });
WeeklyRecapRunSchema.index({ status: 1, lockedUntil: 1 });
WeeklyRecapRunSchema.index({
  timezone: 1,
  weekStart: 1,
  status: 1,
});
WeeklyRecapRunSchema.index({ weekStart: 1, status: 1 });
WeeklyRecapRunSchema.index({ status: 1, weekEnd: 1 });
