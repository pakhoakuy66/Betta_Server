import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum PostCleanupStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  FAILED = 'failed',
  MANUAL_REVIEW = 'manual_review',
}

export enum PostModerationState {
  ACTIVE = 'active',
  HIDDEN = 'hidden',
  TERMINAL_DELETED = 'terminal_deleted',
}

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Post extends Document {
  @Prop({
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  publicId!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  authorId!: Types.ObjectId;

  @Prop({ type: String, default: null, trim: true })
  idempotencyKey?: string | null;

  @Prop({
    type: String,
    required: false,
    trim: true,
    maxlength: 2500,
    default: '',
  })
  content!: string;

  @Prop({
    type: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
      },
    ],
    default: [],
    validate: {
      validator: (images: { url: string; publicId: string }[] = []) =>
        images.length <= 3,
      message: 'Bài viết chỉ được phép có tối đa 3 ảnh',
    },
  })
  images!: { url: string; publicId: string }[];

  @Prop({ type: Number, default: 0 })
  likeCount!: number;

  @Prop({ type: Number, default: 0 })
  shareCount!: number;

  @Prop({
    type: Date,
    required: true,
    immutable: true,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    index: true,
  })
  expireAt!: Date;

  @Prop({
    type: String,
    enum: Object.values(PostCleanupStatus),
    default: PostCleanupStatus.PENDING,
    index: true,
  })
  cleanupStatus!: PostCleanupStatus;

  @Prop({ type: Date, default: null, index: true })
  cleanupLockedUntil?: Date | null;

  @Prop({ type: String, default: null, select: false })
  cleanupLockToken!: string | null;

  /**
   * Point-of-no-return fence. Lease hết hạn sau mốc này không được reclaim;
   * lỗi xóa vật lý phải đi manual review để tránh lặp side effect mơ hồ.
   */
  @Prop({ type: Date, default: null, select: false })
  cleanupDestructiveStartedAt!: Date | null;

  @Prop({ type: Number, default: 0 })
  cleanupAttempts!: number;

  @Prop({ type: String, default: null })
  cleanupLastError?: string | null;

  @Prop({
    type: String,
    enum: Object.values(PostModerationState),
    default: PostModerationState.ACTIVE,
    select: false,
  })
  moderationState!: PostModerationState;

  @Prop({ type: Number, default: 0, min: 0, select: false })
  moderationVersion!: number;

  @Prop({ type: Date, default: null, select: false })
  moderatedAt!: Date | null;

  @Prop({ type: Date, default: null, select: false })
  moderationTerminalAt!: Date | null;

  @Prop({ type: String, default: null, select: false })
  moderationReasonCode!: string | null;

  @Prop({ type: String, default: null, select: false })
  moderatedByAdminPublicId!: string | null;

  @Prop({ type: Number, default: 0, min: 0, select: false })
  moderationNoticeVersion!: number;

  @Prop({ type: Date, default: null, select: false, index: true })
  evidenceHoldUntil!: Date | null;

  @Prop({ type: Boolean, default: false, select: false })
  evidenceUnavailable!: boolean;

  @Prop({ type: Boolean, default: false })
  isDeletedByAdmin!: boolean;
}

export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.pre('validate', function () {
  const post = this as Post;
  const hasContent = Boolean(post.content?.trim());
  const hasImages = Array.isArray(post.images) && post.images.length > 0;

  if (!hasContent && !hasImages) {
    throw new Error('Bài viết phải có nội dung hoặc ít nhất một ảnh');
  }
});

PostSchema.virtual('author', {
  ref: 'User',
  localField: 'authorId',
  foreignField: '_id',
  justOne: true,
});

PostSchema.index({
  authorId: 1,
  createdAt: -1,
  expireAt: 1,
  isDeletedByAdmin: 1,
});

PostSchema.index({
  expireAt: 1,
  isDeletedByAdmin: 1,
  createdAt: -1,
});

PostSchema.index({
  cleanupStatus: 1,
  cleanupLockedUntil: 1,
  cleanupDestructiveStartedAt: 1,
  expireAt: 1,
});

PostSchema.index({
  moderationState: 1,
  cleanupStatus: 1,
  cleanupLockedUntil: 1,
  evidenceHoldUntil: 1,
});

PostSchema.index(
  { authorId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  },
);
