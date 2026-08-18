import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { UserDeletionOrigin } from '../../users/constants/user-moderation.constants';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';
import { ADMIN_LIFECYCLE_HASH_PATTERN } from '../constants/admin-lifecycle.constants';
import { AdminUserDeletionOperation } from '../constants/admin-user-deletion.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_USER_DELETION_REQUEST_COLLECTION =
  'admin_user_deletion_requests' as const;
export const ADMIN_USER_DELETION_IDEMPOTENCY_INDEX =
  'admin_user_deletion_idempotency_unique' as const;
export const ADMIN_USER_DELETION_TTL_INDEX =
  'admin_user_deletion_idempotency_expiry_ttl' as const;

@Schema({
  collection: ADMIN_USER_DELETION_REQUEST_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminUserDeletionRequest {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_LIFECYCLE_HASH_PATTERN,
  })
  idempotencyHash!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_LIFECYCLE_HASH_PATTERN,
  })
  requestFingerprint!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  actorPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_SESSION_PUBLIC_ID_PATTERN,
  })
  actorSessionPublicId!: string;

  @Prop({
    type: Types.ObjectId,
    required: true,
    immutable: true,
    select: false,
  })
  targetUserId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_USER_PUBLIC_ID_PATTERN,
  })
  targetPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(AdminUserDeletionOperation),
  })
  operation!: AdminUserDeletionOperation;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  resultVersion!: number;

  @Prop({ type: Boolean, required: true, immutable: true })
  resultIsDeleted!: boolean;

  @Prop({
    type: String,
    default: null,
    immutable: true,
    enum: [...Object.values(UserDeletionOrigin), null],
  })
  resultDeletionOrigin!: UserDeletionOrigin | null;

  @Prop({ type: Date, default: null, immutable: true })
  resultDeletedAt!: Date | null;

  @Prop({ type: Date, default: null, immutable: true })
  resultRestorableUntil!: Date | null;

  @Prop({ type: Date, required: true, immutable: true })
  resultUpdatedAt!: Date;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  revokedSessionCount!: number;

  @Prop({ type: Date, required: true, immutable: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminUserDeletionRequestDocument =
  HydratedDocument<AdminUserDeletionRequest>;
export const AdminUserDeletionRequestSchema = SchemaFactory.createForClass(
  AdminUserDeletionRequest,
);

AdminUserDeletionRequestSchema.index(
  { idempotencyHash: 1 },
  { name: ADMIN_USER_DELETION_IDEMPOTENCY_INDEX, unique: true },
);
AdminUserDeletionRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  { name: ADMIN_USER_DELETION_TTL_INDEX, expireAfterSeconds: 0 },
);
