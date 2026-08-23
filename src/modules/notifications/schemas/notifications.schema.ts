import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  generateNotificationPublicId,
  isValidNotificationPublicId,
} from '../utils/notification-public-id';
import { UserModerationNoticeAction } from '../../users/constants/user-moderation-notice.constants';
import { USER_MODERATION_NOTICE_PUBLIC_ID_PATTERN } from '../../users/constants/user-moderation-notice.constants';
import {
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
} from '../../users/constants/user-moderation.constants';

export const NOTIFICATION_TTL_DAYS = 14;
export const NOTIFICATION_TTL_MS = NOTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;

export enum NotificationType {
  REACTION = 'REACTION',
  RECAP = 'RECAP',
  EXPIRING = 'EXPIRING',
  FOLLOW = 'FOLLOW',
  SYSTEM_MODERATION = 'SYSTEM_MODERATION',
}

@Schema({ _id: false, strict: 'throw' })
export class SystemModerationNotificationPayload {
  @Prop({
    type: String,
    required: true,
    match: USER_MODERATION_NOTICE_PUBLIC_ID_PATTERN,
  })
  noticePublicId!: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(UserModerationNoticeAction),
  })
  action!: UserModerationNoticeAction;

  @Prop({
    type: String,
    required: true,
    match: USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  })
  publicReasonCode!: string;

  @Prop({ type: Date, required: true })
  effectiveAt!: Date;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({
    type: String,
    required: true,
    match: USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  })
  supportReference!: string;
}

const SystemModerationNotificationPayloadSchema = SchemaFactory.createForClass(
  SystemModerationNotificationPayload,
);

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Notification extends Document {
  @Prop({
    type: String,
    required: true,
    default: generateNotificationPublicId,
    trim: true,
    validate: {
      validator: isValidNotificationPublicId,
      message: 'Notification publicId is invalid',
    },
  })
  publicId!: string;

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

  @Prop({
    type: SystemModerationNotificationPayloadSchema,
    default: undefined,
  })
  moderation?: SystemModerationNotificationPayload;

  @Prop({ type: Boolean, default: false, index: true })
  isRead!: boolean;

  @Prop({
    type: Date,
    default: () => new Date(Date.now() + NOTIFICATION_TTL_MS),
    index: { expires: 0 },
  })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ recipientId: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

NotificationSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    sparse: true,
  },
);

NotificationSchema.pre('validate', function validateModerationContract() {
  const isSystemModeration = this.type === NotificationType.SYSTEM_MODERATION;
  if (isSystemModeration !== Boolean(this.moderation)) {
    throw new Error('SYSTEM_MODERATION payload không hợp lệ');
  }
  if (
    isSystemModeration &&
    (this.actorIds.length !== 0 || this.countedActorIds.length !== 0)
  ) {
    throw new Error('SYSTEM_MODERATION không được chứa actor');
  }
});

NotificationSchema.index(
  { publicId: 1 },
  {
    unique: true,
    sparse: true,
    name: 'notifications_publicId_unique',
  },
);
