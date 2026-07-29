import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  type Types,
} from 'mongoose';

import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { User } from '../../users/schemas/user.schema';
import {
  GOOGLE_SUBJECT_MAX_LENGTH,
  GOOGLE_SUBJECT_PATTERN,
} from './oauth-identity.schema';

export const GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION =
  'auth_google_oauth_continuation_grants';

export const GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH = 43;
export const GOOGLE_OAUTH_CONTINUATION_EMAIL_MAX_LENGTH = 254;
export const GOOGLE_OAUTH_CONTINUATION_FULLNAME_MAX_LENGTH = 200;
export const GOOGLE_OAUTH_CONTINUATION_AVATAR_MAX_LENGTH = 2_048;

export const GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_PATTERN =
  /^[A-Za-z0-9_-]{43}$/u;

export enum GoogleOAuthContinuationGrantPurpose {
  LINK_ACCOUNT = 'LINK_ACCOUNT',
  COMPLETE_REGISTRATION = 'COMPLETE_REGISTRATION',
}

@Schema({
  collection: GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION,
  timestamps: true,
  versionKey: false,
  strict: 'throw',
})
export class GoogleOAuthContinuationGrant {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH,
    maxlength: GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH,
    match: GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_PATTERN,
  })
  grantHash!: string;

  @Prop({
    type: String,
    enum: Object.values(GoogleOAuthContinuationGrantPurpose),
    required: true,
    immutable: true,
    select: false,
  })
  purpose!: GoogleOAuthContinuationGrantPurpose;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: 1,
    maxlength: GOOGLE_SUBJECT_MAX_LENGTH,
    match: GOOGLE_SUBJECT_PATTERN,
  })
  providerAccountId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    select: false,
    minlength: 1,
    maxlength: GOOGLE_OAUTH_CONTINUATION_EMAIL_MAX_LENGTH,
    set: normalizeAuthEmail,
  })
  email!: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: User.name,
    default: null,
    immutable: true,
    select: false,
  })
  targetUserId!: Types.ObjectId | null;

  @Prop({
    type: String,
    default: null,
    immutable: true,
    select: false,
    maxlength: GOOGLE_OAUTH_CONTINUATION_FULLNAME_MAX_LENGTH,
  })
  fullname!: string | null;

  @Prop({
    type: String,
    default: null,
    immutable: true,
    select: false,
    maxlength: GOOGLE_OAUTH_CONTINUATION_AVATAR_MAX_LENGTH,
  })
  avatar!: string | null;

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

export type GoogleOAuthContinuationGrantDocument =
  HydratedDocument<GoogleOAuthContinuationGrant>;

export const GoogleOAuthContinuationGrantSchema = SchemaFactory.createForClass(
  GoogleOAuthContinuationGrant,
);

GoogleOAuthContinuationGrantSchema.pre(
  'validate',
  function validatePurposeContract() {
    const isLinkGrant =
      this.purpose === GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT;

    const isRegistrationGrant =
      this.purpose ===
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION;

    if (isLinkGrant && !this.targetUserId) {
      this.invalidate(
        'targetUserId',
        'LINK_ACCOUNT grant yêu cầu targetUserId',
      );
    }

    if (isLinkGrant && this.fullname !== null) {
      this.invalidate(
        'fullname',
        'LINK_ACCOUNT grant không được chứa fullname',
      );
    }

    if (isLinkGrant && this.avatar !== null) {
      this.invalidate('avatar', 'LINK_ACCOUNT grant không được chứa avatar');
    }

    if (isRegistrationGrant && this.targetUserId !== null) {
      this.invalidate(
        'targetUserId',
        'COMPLETE_REGISTRATION grant không được chứa targetUserId',
      );
    }
  },
);

const rejectGrantReplacement = (): never => {
  throw new Error('Google OAuth continuation grants cannot be replaced');
};

const rejectGrantBulkWrite = (): never => {
  throw new Error(
    'Google OAuth continuation grant bulk writes are not allowed',
  );
};

GoogleOAuthContinuationGrantSchema.pre('replaceOne', rejectGrantReplacement);

GoogleOAuthContinuationGrantSchema.pre(
  'findOneAndReplace',
  rejectGrantReplacement,
);

GoogleOAuthContinuationGrantSchema.pre('bulkWrite', rejectGrantBulkWrite);

/*
 * Replacement và bulk operations bị chặn.
 * Mọi state mutation khác phải đi qua continuation-grant
 * lifecycle service nội bộ.
 */

GoogleOAuthContinuationGrantSchema.index(
  { grantHash: 1 },
  {
    unique: true,
    name: 'grantHash_1',
  },
);

GoogleOAuthContinuationGrantSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'expiresAt_ttl',
  },
);
