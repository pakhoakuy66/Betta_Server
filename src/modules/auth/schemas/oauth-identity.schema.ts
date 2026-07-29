import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export const OAUTH_IDENTITY_COLLECTION = 'auth_oauth_identities';

export const GOOGLE_SUBJECT_MAX_LENGTH = 255;

export const GOOGLE_SUBJECT_PATTERN = /^[\x21-\x7e]+$/u;

export enum OAuthProvider {
  GOOGLE = 'google',
}

@Schema({
  collection: OAUTH_IDENTITY_COLLECTION,
  timestamps: true,
  versionKey: false,
  strict: 'throw',
})
export class OAuthIdentity {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: User.name,
    required: true,
    immutable: true,
  })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(OAuthProvider),
    required: true,
    immutable: true,
  })
  provider!: OAuthProvider;

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

  createdAt!: Date;
  updatedAt!: Date;
}

export type OAuthIdentityDocument = HydratedDocument<OAuthIdentity>;

export const OAuthIdentitySchema = SchemaFactory.createForClass(OAuthIdentity);

OAuthIdentitySchema.index(
  {
    provider: 1,
    providerAccountId: 1,
  },
  {
    unique: true,
    name: 'provider_1_providerAccountId_1',
  },
);

OAuthIdentitySchema.index(
  {
    userId: 1,
    provider: 1,
  },
  {
    unique: true,
    name: 'userId_1_provider_1',
  },
);
