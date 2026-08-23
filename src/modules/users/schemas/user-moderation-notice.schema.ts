import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import {
  OUTBOX_DEDUPE_KEY_PATTERN,
  OUTBOX_PUBLIC_ID_PATTERN,
} from '../../../common/outbox/outbox.constants';
import {
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
} from '../constants/user-moderation.constants';
import {
  USER_MODERATION_NOTICE_COLLECTION,
  USER_MODERATION_NOTICE_PUBLIC_ID_PATTERN,
  USER_MODERATION_NOTICE_RETENTION_INDEX,
  USER_MODERATION_NOTICE_SCHEMA_VERSION,
  USER_MODERATION_NOTICE_SOURCE_DEDUPE_INDEX,
  USER_MODERATION_NOTICE_SOURCE_EVENT_INDEX,
  USER_MODERATION_NOTICE_SUPPORT_INDEX,
  USER_MODERATION_NOTICE_TIMELINE_INDEX,
  UserModerationNoticeAction,
  UserModerationNoticeStatus,
} from '../constants/user-moderation-notice.constants';
import { USER_PUBLIC_ID_PATTERN } from '../utils/generate-public-id';
import { generateUserModerationNoticePublicId } from '../utils/generate-user-moderation-notice-public-id';

@Schema({
  collection: USER_MODERATION_NOTICE_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: { createdAt: 'createdAt', updatedAt: false },
})
export class UserModerationNotice {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: generateUserModerationNoticePublicId,
    match: USER_MODERATION_NOTICE_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    default: USER_MODERATION_NOTICE_SCHEMA_VERSION,
    enum: [USER_MODERATION_NOTICE_SCHEMA_VERSION],
  })
  schemaVersion!: typeof USER_MODERATION_NOTICE_SCHEMA_VERSION;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_PUBLIC_ID_PATTERN,
  })
  sourceEventPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: OUTBOX_DEDUPE_KEY_PATTERN,
  })
  sourceDedupeKey!: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
    select: false,
  })
  targetUserId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: USER_PUBLIC_ID_PATTERN,
  })
  targetPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['SYSTEM_MODERATION'],
  })
  noticeType!: 'SYSTEM_MODERATION';

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(UserModerationNoticeAction),
  })
  publicAction!: UserModerationNoticeAction;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  })
  publicReasonCode!: string;

  @Prop({ type: Date, required: true, immutable: true })
  effectiveAt!: Date;

  @Prop({ type: Date, default: null, immutable: true })
  expiresAt!: Date | null;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  })
  supportReference!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(UserModerationNoticeStatus),
  })
  status!: UserModerationNoticeStatus;

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  retentionExpiresAt!: Date;

  createdAt!: Date;
}

export type UserModerationNoticeDocument =
  HydratedDocument<UserModerationNotice>;
export const UserModerationNoticeSchema =
  SchemaFactory.createForClass(UserModerationNotice);

UserModerationNoticeSchema.index(
  { sourceEventPublicId: 1 },
  { name: USER_MODERATION_NOTICE_SOURCE_EVENT_INDEX, unique: true },
);
UserModerationNoticeSchema.index(
  { sourceDedupeKey: 1 },
  { name: USER_MODERATION_NOTICE_SOURCE_DEDUPE_INDEX, unique: true },
);
UserModerationNoticeSchema.index(
  { supportReference: 1 },
  { name: USER_MODERATION_NOTICE_SUPPORT_INDEX, unique: true },
);
UserModerationNoticeSchema.index(
  { targetPublicId: 1, occurredAt: -1, publicId: 1 },
  { name: USER_MODERATION_NOTICE_TIMELINE_INDEX },
);
UserModerationNoticeSchema.index(
  { retentionExpiresAt: 1 },
  { name: USER_MODERATION_NOTICE_RETENTION_INDEX, expireAfterSeconds: 0 },
);

const rejectMutation = (): never => {
  throw new Error('User moderation notices are append-only');
};

UserModerationNoticeSchema.pre('save', function rejectDocumentUpdate() {
  if (!this.isNew) rejectMutation();
});
UserModerationNoticeSchema.pre(
  'deleteOne',
  { document: true, query: false },
  rejectMutation,
);
UserModerationNoticeSchema.pre(
  'deleteOne',
  { document: false, query: true },
  rejectMutation,
);
UserModerationNoticeSchema.pre('deleteMany', rejectMutation);
UserModerationNoticeSchema.pre('updateOne', rejectMutation);
UserModerationNoticeSchema.pre('updateMany', rejectMutation);
UserModerationNoticeSchema.pre('replaceOne', rejectMutation);
UserModerationNoticeSchema.pre('findOneAndUpdate', rejectMutation);
UserModerationNoticeSchema.pre('findOneAndReplace', rejectMutation);
UserModerationNoticeSchema.pre('findOneAndDelete', rejectMutation);
UserModerationNoticeSchema.pre('bulkWrite', rejectMutation);
