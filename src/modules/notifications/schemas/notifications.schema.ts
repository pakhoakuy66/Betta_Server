import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export const NOTIFICATION_TTL_DAYS = 14;
export const NOTIFICATION_TTL_MS = NOTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;

export enum NotificationType {
  REACTION = 'REACTION',
  RECAP = 'RECAP',
  EXPIRING = 'EXPIRING',
  FOLLOW = 'FOLLOW',
}

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Notification extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  recipientId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: Object.values(NotificationType),
    index: true,
  })
  type!: NotificationType;

  // Top actors gần nhất để render avatar/name trên UI.
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  actorIds!: Types.ObjectId[];

  /*
   * Actor đã từng được tính vào notification group.
   * Đây là dữ liệu phục vụ actorCount, không phải danh sách user hiện còn đang like.
   */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  countedActorIds!: Types.ObjectId[];

  @Prop({ type: Number, default: 0 })
  actorCount!: number;

  @Prop({ type: Number, default: 0 })
  otherCount!: number;

  @Prop({ type: String, required: true })
  content!: string;

  @Prop({ type: Types.ObjectId })
  targetId?: Types.ObjectId;

  @Prop({ type: String })
  targetPublicId?: string;

  @Prop({ type: String })
  dedupeKey?: string;

  @Prop({ type: Boolean, default: false, index: true })
  isRead!: boolean;

  @Prop({
    type: Date,
    default: () => new Date(Date.now() + NOTIFICATION_TTL_MS),
    index: { expires: 0 },
  })
  expiresAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ recipientId: 1, createdAt: -1 });

NotificationSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    sparse: true,
  },
);
