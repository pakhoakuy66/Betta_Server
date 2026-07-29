import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import {
  BASE64URL_PATTERN,
  GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_BULK_WRITE_ERROR,
  GOOGLE_OAUTH_SESSION_HANDOFF_COLLECTION,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
  GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
  GOOGLE_OAUTH_SESSION_HANDOFF_REPLACEMENT_ERROR,
  GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
} from '../constants/google-oauth-session-handoff.constants';

@Schema({
  collection: GOOGLE_OAUTH_SESSION_HANDOFF_COLLECTION,
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  strictQuery: 'throw',
})
export class GoogleOAuthSessionHandoff {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
    maxlength: GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
    match: BASE64URL_PATTERN,
  })
  handoffHash!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    select: false,
    enum: [GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION],
  })
  payloadVersion!: number;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: 1,
    maxlength: GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH,
    match: BASE64URL_PATTERN,
  })
  payloadCiphertext!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
    maxlength: GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
    match: BASE64URL_PATTERN,
  })
  payloadIv!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
    maxlength: GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
    match: BASE64URL_PATTERN,
  })
  payloadAuthTag!: string;

  @Prop({
    type: Date,
    required: true,
    immutable: true,
  })
  expiresAt!: Date;

  @Prop({
    type: Date,
    default: null,
  })
  consumedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type GoogleOAuthSessionHandoffDocument =
  HydratedDocument<GoogleOAuthSessionHandoff>;

export const GoogleOAuthSessionHandoffSchema = SchemaFactory.createForClass(
  GoogleOAuthSessionHandoff,
);

const rejectReplacement = (): never => {
  throw new Error(GOOGLE_OAUTH_SESSION_HANDOFF_REPLACEMENT_ERROR);
};

const rejectBulkWrite = (): never => {
  throw new Error(GOOGLE_OAUTH_SESSION_HANDOFF_BULK_WRITE_ERROR);
};

GoogleOAuthSessionHandoffSchema.pre('replaceOne', rejectReplacement);

GoogleOAuthSessionHandoffSchema.pre('findOneAndReplace', rejectReplacement);

GoogleOAuthSessionHandoffSchema.pre('bulkWrite', rejectBulkWrite);

GoogleOAuthSessionHandoffSchema.index(
  { handoffHash: 1 },
  {
    unique: true,
    name: GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
  },
);

GoogleOAuthSessionHandoffSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
  },
);
