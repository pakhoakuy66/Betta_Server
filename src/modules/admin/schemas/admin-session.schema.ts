import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import {
  ADMIN_SESSION_FAMILY_PATTERN,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import {
  ADMIN_SESSION_COLLECTION,
  ADMIN_SESSION_FAMILY_INDEX,
  ADMIN_SESSION_OWNER_LIST_INDEX,
  ADMIN_SESSION_PUBLIC_ID_INDEX,
  ADMIN_SESSION_TTL_INDEX,
  AdminSessionRevokeReason,
} from '../constants/admin-session.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

const isNonNegativeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Schema({
  collection: ADMIN_SESSION_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminSession {
  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  adminAccountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  adminPublicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: ADMIN_SESSION_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    match: ADMIN_SESSION_FAMILY_PATTERN,
  })
  tokenFamily!: string;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
    select: false,
    validate: { validator: isNonNegativeInteger },
  })
  tokenVersion!: number;

  @Prop({
    type: String,
    required: true,
    select: false,
    minlength: 74,
    maxlength: 74,
  })
  refreshTokenHash!: string;

  @Prop({ type: String, required: true, maxlength: 80 })
  deviceLabel!: string;

  @Prop({ type: Date, required: true })
  lastUsedAt!: Date;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({
    type: String,
    enum: Object.values(AdminSessionRevokeReason),
    default: null,
  })
  revokeReason!: AdminSessionRevokeReason | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminSessionDocument = HydratedDocument<AdminSession>;
export const AdminSessionSchema = SchemaFactory.createForClass(AdminSession);

AdminSessionSchema.index(
  { publicId: 1 },
  { name: ADMIN_SESSION_PUBLIC_ID_INDEX, unique: true },
);
AdminSessionSchema.index(
  { tokenFamily: 1 },
  { name: ADMIN_SESSION_FAMILY_INDEX, unique: true },
);
AdminSessionSchema.index(
  { expiresAt: 1 },
  { name: ADMIN_SESSION_TTL_INDEX, expireAfterSeconds: 0 },
);
AdminSessionSchema.index(
  {
    adminAccountId: 1,
    revokedAt: 1,
    expiresAt: 1,
    lastUsedAt: -1,
    publicId: 1,
  },
  { name: ADMIN_SESSION_OWNER_LIST_INDEX },
);
