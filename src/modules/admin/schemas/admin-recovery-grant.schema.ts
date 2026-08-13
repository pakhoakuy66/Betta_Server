import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import {
  ADMIN_RECOVERY_GRANT_PUBLIC_ID_PATTERN,
  ADMIN_SECURITY_GRANT_HASH_PATTERN,
  AdminRecoveryPurpose,
} from '../constants/admin-account-recovery.constants';
import { generateAdminRecoveryGrantPublicId } from '../utils/admin-security-grant';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_RECOVERY_GRANT_COLLECTION = 'admin_recovery_grants';

@Schema({
  collection: ADMIN_RECOVERY_GRANT_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminRecoveryGrant {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: generateAdminRecoveryGrantPublicId,
    match: ADMIN_RECOVERY_GRANT_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

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
    index: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  targetAdminPublicId!: string;

  @Prop({ type: String, enum: AdminRecoveryPurpose, required: true })
  purpose!: AdminRecoveryPurpose;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    unique: true,
    select: false,
    match: ADMIN_SECURITY_GRANT_HASH_PATTERN,
  })
  grantHash!: string;

  @Prop({ type: Number, required: true, min: 0, select: false })
  credentialVersionAtIssue!: number;

  @Prop({ type: String, required: true, select: false, maxlength: 512 })
  secretReference!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;

  @Prop({ type: Date, default: null })
  revokedAt?: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminRecoveryGrantDocument = HydratedDocument<AdminRecoveryGrant>;
export const AdminRecoveryGrantSchema =
  SchemaFactory.createForClass(AdminRecoveryGrant);

AdminRecoveryGrantSchema.index(
  { expiresAt: 1 },
  { name: 'admin_recovery_grants_expiresAt_ttl', expireAfterSeconds: 0 },
);
AdminRecoveryGrantSchema.index(
  { targetAdminPublicId: 1, purpose: 1, createdAt: -1 },
  { name: 'admin_recovery_grants_target_purpose_createdAt' },
);
