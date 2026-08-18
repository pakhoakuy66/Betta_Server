import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

export type AuthSessionDocument = HydratedDocument<AuthSession>;

export enum SessionRevokeReason {
  LOGOUT = 'logout',
  LOGOUT_ALL = 'logout_all',
  PASSWORD_CHANGED = 'password_changed',
  PASSWORD_RESET = 'password_reset',
  ACCOUNT_DELETED = 'account_deleted',
  ACCOUNT_BLOCKED = 'account_blocked',
  ACCOUNT_RESTRICTED = 'account_restricted',
  REFRESH_REPLAY = 'refresh_replay',
  SESSION_REVOKED = 'session_revoked',
}

@Schema({ collection: 'auth_sessions', timestamps: true })
export class AuthSession {
  @Prop({
    type: Types.ObjectId,
    required: true,
    immutable: true,
  })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    unique: true,
    immutable: true,
    trim: true,
    minlength: 20,
    maxlength: 64,
  })
  publicId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    trim: true,
    minlength: 20,
    maxlength: 64,
  })
  tokenFamily!: string;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'tokenVersion phải là số nguyên không âm',
    },
  })
  tokenVersion!: number;

  @Prop({
    type: String,
    required: true,
    select: false,
    maxlength: 128,
  })
  refreshTokenHash!: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  })
  deviceLabel!: string;

  @Prop({ type: Date, required: true })
  lastUsedAt!: Date;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({
    type: String,
    enum: Object.values(SessionRevokeReason),
    default: null,
  })
  revokeReason!: SessionRevokeReason | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AuthSessionSchema = SchemaFactory.createForClass(AuthSession);

AuthSessionSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'expiresAt_ttl',
  },
);

AuthSessionSchema.index(
  { userId: 1, revokedAt: 1, lastUsedAt: -1 },
  {
    name: 'userId_1_revokedAt_1_lastUsedAt_-1',
  },
);
