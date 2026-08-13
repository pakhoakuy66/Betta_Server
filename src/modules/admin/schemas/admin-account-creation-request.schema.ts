import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';
import { ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN } from '../constants/admin-bootstrap.constants';
import { ADMIN_LIFECYCLE_HASH_PATTERN } from '../constants/admin-lifecycle.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_ACCOUNT_CREATION_REQUEST_COLLECTION =
  'admin_account_creation_requests';
export const ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_INDEX =
  'admin_account_creation_idempotency_unique';
export const ADMIN_ACCOUNT_CREATION_TTL_INDEX =
  'admin_account_creation_idempotency_expiry_ttl';

@Schema({
  collection: ADMIN_ACCOUNT_CREATION_REQUEST_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminAccountCreationRequest {
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
  targetAdminAccountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  targetAdminPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN,
  })
  secretReference!: string;

  @Prop({ type: Date, required: true, immutable: true })
  activationExpiresAt!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminAccountCreationRequestDocument =
  HydratedDocument<AdminAccountCreationRequest>;
export const AdminAccountCreationRequestSchema = SchemaFactory.createForClass(
  AdminAccountCreationRequest,
);

AdminAccountCreationRequestSchema.index(
  { idempotencyHash: 1 },
  { name: ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_INDEX, unique: true },
);
AdminAccountCreationRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  { name: ADMIN_ACCOUNT_CREATION_TTL_INDEX, expireAfterSeconds: 0 },
);
