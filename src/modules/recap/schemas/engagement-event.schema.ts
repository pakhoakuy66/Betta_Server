import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum EngagementEventType {
  POST_CREATED = 'POST_CREATED',
  REACTION_CREATED = 'REACTION_CREATED',
}

@Schema({
  timestamps: true,
  collection: 'engagement_events',
})
export class EngagementEvent extends Document {
  @Prop({ type: String, required: true, unique: true })
  eventKey!: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(EngagementEventType),
    index: true,
  })
  type!: EngagementEventType;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  actorId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  postOwnerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Post', required: true, index: true })
  postId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  postPublicId!: string;

  @Prop({ type: Date, required: true, index: true })
  occurredAt!: Date;

  @Prop({ type: Date, required: true })
  weekStart!: Date;

  @Prop({ type: Date, required: true })
  weekEnd!: Date;

  @Prop({ type: String, required: true })
  timezone!: string;
}

export const EngagementEventSchema =
  SchemaFactory.createForClass(EngagementEvent);

EngagementEventSchema.index({ postOwnerId: 1, occurredAt: -1 });
EngagementEventSchema.index({ actorId: 1, occurredAt: -1 });
EngagementEventSchema.index({ postOwnerId: 1, weekStart: 1 });
EngagementEventSchema.index({ actorId: 1, weekStart: 1 });
EngagementEventSchema.index({ postId: 1, weekStart: 1 });
EngagementEventSchema.index({ type: 1, occurredAt: 1 });
EngagementEventSchema.index({ type: 1, postId: 1, weekStart: 1 });
EngagementEventSchema.index({
  timezone: 1,
  weekStart: 1,
});
EngagementEventSchema.index({ weekEnd: 1, timezone: 1, weekStart: 1 });
