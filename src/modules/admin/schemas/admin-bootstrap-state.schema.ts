import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';
import {
  ADMIN_BOOTSTRAP_GRANT_HASH_PATTERN,
  ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN,
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export const ADMIN_BOOTSTRAP_STATE_COLLECTION = 'admin_bootstrap_states';
export const ADMIN_BOOTSTRAP_STATE_KEY_INDEX =
  'admin_bootstrap_states_key_unique';
export const ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX =
  'admin_bootstrap_states_admin_public_id_unique';

const isPositiveInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 1;

@Schema({
  collection: ADMIN_BOOTSTRAP_STATE_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminBootstrapState {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [ADMIN_BOOTSTRAP_SINGLETON_KEY],
  })
  key!: typeof ADMIN_BOOTSTRAP_SINGLETON_KEY;

  @Prop({
    type: SchemaTypes.ObjectId,
    required: true,
    immutable: true,
  })
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
    enum: Object.values(AdminActivationGrantPurpose),
  })
  purpose!: AdminActivationGrantPurpose;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: Object.values(AdminBootstrapEnvironment),
  })
  environment!: AdminBootstrapEnvironment;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: { validator: isPositiveInteger },
  })
  generation!: number;

  @Prop({
    type: String,
    required: true,
    select: false,
    match: ADMIN_BOOTSTRAP_GRANT_HASH_PATTERN,
  })
  grantHash!: string;

  @Prop({ type: Date, required: true })
  grantExpiresAt!: Date;

  @Prop({ type: Date, default: null, select: false })
  consumedAt?: Date | null;

  @Prop({
    type: String,
    required: true,
    select: false,
    maxlength: 512,
    match: ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN,
  })
  secretReference!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminBootstrapStateDocument = HydratedDocument<AdminBootstrapState>;
export const AdminBootstrapStateSchema =
  SchemaFactory.createForClass(AdminBootstrapState);

AdminBootstrapStateSchema.index(
  { key: 1 },
  { name: ADMIN_BOOTSTRAP_STATE_KEY_INDEX, unique: true },
);
AdminBootstrapStateSchema.index(
  { adminPublicId: 1 },
  { name: ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX, unique: true },
);
