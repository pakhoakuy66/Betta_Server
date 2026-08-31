import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { PostModerationState } from '../../posts/schemas/post.schema';
import {
  AdminPostModerationOperation,
  AdminPostModerationRequestState,
  ADMIN_POST_MODERATION_IDEMPOTENCY_INDEX,
  ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_INDEX,
} from '../constants/admin-post-moderation.constants';

@Schema({
  timestamps: true,
  collection: 'admin_post_moderation_requests',
  strict: 'throw',
})
export class AdminPostModerationRequest extends Document {
  @Prop({ type: String, required: true, select: false })
  idempotencyHash!: string;

  @Prop({ type: String, required: true, select: false })
  requestFingerprint!: string;

  @Prop({ type: String, required: true })
  actorPublicId!: string;

  @Prop({ type: String, required: true })
  actorSessionPublicId!: string;

  @Prop({ type: String, required: true })
  postPublicId!: string;

  @Prop({
    type: String,
    enum: Object.values(AdminPostModerationOperation),
    required: true,
  })
  operation!: AdminPostModerationOperation;

  @Prop({
    type: String,
    enum: Object.values(AdminPostModerationRequestState),
    required: true,
    default: AdminPostModerationRequestState.PENDING,
  })
  state!: AdminPostModerationRequestState;

  @Prop({
    type: String,
    enum: Object.values(PostModerationState),
    default: null,
  })
  resultState!: PostModerationState | null;

  @Prop({ type: Number, default: null, min: 1 })
  resultModerationVersion!: number | null;

  @Prop({ type: Date, default: null })
  resultModeratedAt!: Date | null;

  @Prop({ type: Boolean, default: null })
  resultCleanupRequested!: boolean | null;

  @Prop({ type: Date, required: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AdminPostModerationRequestSchema = SchemaFactory.createForClass(
  AdminPostModerationRequest,
);

AdminPostModerationRequestSchema.index(
  { idempotencyHash: 1 },
  { unique: true, name: ADMIN_POST_MODERATION_IDEMPOTENCY_INDEX },
);
AdminPostModerationRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: ADMIN_POST_MODERATION_IDEMPOTENCY_TTL_INDEX,
  },
);
