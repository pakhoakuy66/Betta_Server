import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import {
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';
import { ADMIN_LIFECYCLE_HASH_PATTERN } from '../constants/admin-lifecycle.constants';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';
import { AdminUserRestrictionOperation } from '../constants/admin-user-restriction.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_USER_RESTRICTION_REQUEST_COLLECTION =
  'admin_user_restriction_requests' as const;
export const ADMIN_USER_RESTRICTION_IDEMPOTENCY_INDEX =
  'admin_user_restriction_idempotency_unique' as const;
export const ADMIN_USER_RESTRICTION_TTL_INDEX =
  'admin_user_restriction_idempotency_expiry_ttl' as const;

@Schema({
  collection: ADMIN_USER_RESTRICTION_REQUEST_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminUserRestrictionRequest {
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
    enum: Object.values(AdminUserRestrictionOperation),
  })
  operation!: AdminUserRestrictionOperation;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(UserRestrictionType),
  })
  restrictionType!: UserRestrictionType;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  resultVersion!: number;

  @Prop({ type: Date, default: null, immutable: true })
  resultEffectiveAt!: Date | null;

  @Prop({ type: Date, default: null, immutable: true })
  resultExpiresAt!: Date | null;

  @Prop({
    type: String,
    default: null,
    immutable: true,
    match: USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  })
  resultSupportReference!: string | null;

  @Prop({
    type: String,
    default: null,
    immutable: true,
    match: USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  })
  resultPublicReasonCode!: string | null;

  @Prop({ type: Date, required: true, immutable: true })
  resultUpdatedAt!: Date;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  revokedSessionCount!: number;

  @Prop({ type: Date, required: true, immutable: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminUserRestrictionRequestDocument =
  HydratedDocument<AdminUserRestrictionRequest>;
export const AdminUserRestrictionRequestSchema = SchemaFactory.createForClass(
  AdminUserRestrictionRequest,
);

AdminUserRestrictionRequestSchema.index(
  { idempotencyHash: 1 },
  { name: ADMIN_USER_RESTRICTION_IDEMPOTENCY_INDEX, unique: true },
);
AdminUserRestrictionRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  { name: ADMIN_USER_RESTRICTION_TTL_INDEX, expireAfterSeconds: 0 },
);
