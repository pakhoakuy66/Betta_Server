import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { RECAP_TIMEZONE } from '../utils/recap-week.util';

@Schema({
  timestamps: true,
  collection: 'weekly_recaps',
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class WeeklyRecap extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  year!: number;

  @Prop({ type: Number, required: true })
  weekNumber!: number;

  @Prop({ type: String, required: true })
  weekKey!: string;

  @Prop({ type: Date, required: true, index: true })
  weekStart!: Date;

  @Prop({ type: Date, required: true })
  weekEnd!: Date;

  @Prop({ type: String, required: true, default: RECAP_TIMEZONE })
  timezone!: string;

  @Prop({
    type: {
      postsCount: { type: Number, default: 0 },
      heartsGave: { type: Number, default: 0 },
      heartsReceived: { type: Number, default: 0 },
      topGivers: [{ type: Types.ObjectId, ref: 'User' }],
      topReceivers: [{ type: Types.ObjectId, ref: 'User' }],
    },
    _id: false,
    required: true,
    default: () => ({
      postsCount: 0,
      heartsGave: 0,
      heartsReceived: 0,
      topGivers: [],
      topReceivers: [],
    }),
  })
  stats!: {
    postsCount: number;
    heartsGave: number;
    heartsReceived: number;
    topGivers: Types.ObjectId[];
    topReceivers: Types.ObjectId[];
  };

  @Prop({ type: Boolean, default: false })
  isSeen!: boolean;
}

export const WeeklyRecapSchema = SchemaFactory.createForClass(WeeklyRecap);

WeeklyRecapSchema.index(
  { userId: 1, weekKey: 1, timezone: 1 },
  { unique: true },
);

WeeklyRecapSchema.index({ userId: 1, weekStart: -1 });
WeeklyRecapSchema.index({ weekStart: 1, weekEnd: 1 });
