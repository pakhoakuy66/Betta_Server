import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

export const GOOGLE_OAUTH_TRANSACTION_COLLECTION =
  'auth_google_oauth_transactions';

export const SHA256_BASE64URL_LENGTH = 43;
export const PKCE_VERIFIER_CIPHERTEXT_MIN_LENGTH = 58;
export const PKCE_VERIFIER_CIPHERTEXT_MAX_LENGTH = 171;
export const AES_GCM_IV_BASE64URL_LENGTH = 16;
export const AES_GCM_AUTH_TAG_BASE64URL_LENGTH = 22;

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
export const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

@Schema({
  collection: GOOGLE_OAUTH_TRANSACTION_COLLECTION,
  timestamps: true,
  versionKey: false,
  strict: 'throw',
})
export class GoogleOAuthTransaction {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: SHA256_BASE64URL_LENGTH,
    maxlength: SHA256_BASE64URL_LENGTH,
    match: SHA256_BASE64URL_PATTERN,
  })
  stateHash!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: SHA256_BASE64URL_LENGTH,
    maxlength: SHA256_BASE64URL_LENGTH,
    match: SHA256_BASE64URL_PATTERN,
  })
  nonceHash!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: PKCE_VERIFIER_CIPHERTEXT_MIN_LENGTH,
    maxlength: PKCE_VERIFIER_CIPHERTEXT_MAX_LENGTH,
    match: BASE64URL_PATTERN,
  })
  codeVerifierCiphertext!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: AES_GCM_IV_BASE64URL_LENGTH,
    maxlength: AES_GCM_IV_BASE64URL_LENGTH,
    match: BASE64URL_PATTERN,
  })
  codeVerifierIv!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: AES_GCM_AUTH_TAG_BASE64URL_LENGTH,
    maxlength: AES_GCM_AUTH_TAG_BASE64URL_LENGTH,
    match: BASE64URL_PATTERN,
  })
  codeVerifierAuthTag!: string;

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

export type GoogleOAuthTransactionDocument =
  HydratedDocument<GoogleOAuthTransaction>;

export const GoogleOAuthTransactionSchema = SchemaFactory.createForClass(
  GoogleOAuthTransaction,
);

GoogleOAuthTransactionSchema.index(
  { stateHash: 1 },
  {
    unique: true,
    name: 'stateHash_1',
  },
);

GoogleOAuthTransactionSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'expiresAt_ttl',
  },
);
