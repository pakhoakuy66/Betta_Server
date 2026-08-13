import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import {
  ADMIN_REAUTH_GRANT_HASH_PATTERN,
  ADMIN_REAUTH_GRANT_PUBLIC_ID_PATTERN,
  AdminReauthPurpose,
} from '../constants/admin-reauth.constants';
import { generateAdminReauthGrantPublicId } from '../utils/admin-security-grant';
import { ADMIN_SESSION_PUBLIC_ID_PATTERN } from '../constants/admin-auth-token.constants';
import { ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN } from '../constants/admin-audit.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_REAUTH_GRANT_COLLECTION = 'admin_reauth_grants';

@Schema({
  collection: ADMIN_REAUTH_GRANT_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminReauthGrant {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: generateAdminReauthGrantPublicId,
    match: ADMIN_REAUTH_GRANT_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: Types.ObjectId,
    required: true,
    immutable: true,
    select: false,
  })
  adminAccountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    index: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  adminPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    index: true,
    match: ADMIN_SESSION_PUBLIC_ID_PATTERN,
  })
  sessionPublicId!: string;

  @Prop({ type: String, enum: AdminReauthPurpose, required: true })
  purpose!: AdminReauthPurpose;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
  })
  targetPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    unique: true,
    select: false,
    match: ADMIN_REAUTH_GRANT_HASH_PATTERN,
  })
  grantHash!: string;

  @Prop({ type: Number, required: true, min: 0, select: false })
  credentialVersion!: number;

  @Prop({ type: Number, required: true, min: 0, select: false })
  authzVersion!: number;

  @Prop({ type: Number, required: true, min: 1, select: false })
  permissionVersion!: number;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminReauthGrantDocument = HydratedDocument<AdminReauthGrant>;
export const AdminReauthGrantSchema =
  SchemaFactory.createForClass(AdminReauthGrant);

AdminReauthGrantSchema.index(
  { expiresAt: 1 },
  { name: 'admin_reauth_grants_expiresAt_ttl', expireAfterSeconds: 0 },
);
AdminReauthGrantSchema.index(
  { adminPublicId: 1, sessionPublicId: 1, purpose: 1, expiresAt: 1 },
  { name: 'admin_reauth_grants_principal_session_purpose_expiry' },
);
