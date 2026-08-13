import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';
import {
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  AdminAccountStateInvariantError,
  assertAdminAccountState,
} from '../domain/admin-account-state.invariant';
import {
  ADMIN_PUBLIC_ID_PATTERN,
  generateAdminPublicId,
} from '../utils/generate-admin-public-id';

export {
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';

export const ADMIN_ACCOUNT_COLLECTION = 'admin_accounts';
export const ADMIN_ACCOUNT_PUBLIC_ID_INDEX = 'admin_accounts_publicId_unique';
export const ADMIN_ACCOUNT_EMAIL_INDEX = 'admin_accounts_email_unique';
export const ADMIN_ACCOUNT_USERNAME_INDEX = 'admin_accounts_username_unique';
export const ADMIN_ACCOUNT_LIST_INDEX =
  'admin_accounts_status_role_createdAt_publicId';
export const ADMIN_ACCOUNT_GLOBAL_LIST_INDEX =
  'admin_accounts_createdAt_publicId';

const ADMIN_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVATION_GRANT_HASH_PATTERN = /^[a-f0-9]{64}$/;

const isNonNegativeInteger = (value: unknown): boolean =>
  Number.isInteger(value) && Number(value) >= 0;

const areValidRecoveryHashes = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 10 &&
  value.every(
    (item) =>
      typeof item === 'string' && item.length >= 32 && item.length <= 255,
  );

@Schema({
  collection: ADMIN_ACCOUNT_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminAccount {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: generateAdminPublicId,
    match: ADMIN_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 254,
    match: EMAIL_PATTERN,
  })
  email!: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 40,
    match: ADMIN_USERNAME_PATTERN,
  })
  username!: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
  })
  displayName!: string;

  @Prop({ type: String, enum: AdminRole, required: true, immutable: true })
  role!: AdminRole;

  @Prop({
    type: String,
    enum: AdminAccountStatus,
    default: AdminAccountStatus.PENDING_ACTIVATION,
    required: true,
  })
  status!: AdminAccountStatus;

  @Prop({ type: String, select: false, minlength: 32, maxlength: 255 })
  passwordHash?: string;

  @Prop({ type: Boolean, default: true })
  mustChangePassword!: boolean;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
    select: false,
    validate: { validator: isNonNegativeInteger },
  })
  credentialVersion!: number;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
    select: false,
    validate: { validator: isNonNegativeInteger },
  })
  authzVersion!: number;

  @Prop({
    type: Number,
    default: 1,
    min: 1,
    select: false,
    validate: { validator: isNonNegativeInteger },
  })
  permissionVersion!: number;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
    select: false,
    validate: { validator: isNonNegativeInteger },
  })
  version!: number;

  @Prop({
    type: String,
    enum: AdminMfaStatus,
    default: AdminMfaStatus.NOT_ENROLLED,
    required: true,
  })
  mfaStatus!: AdminMfaStatus;

  @Prop({ type: String, select: false, maxlength: 4096 })
  encryptedTotpSecret?: string;

  @Prop({ type: String, select: false, maxlength: 4096 })
  pendingEncryptedTotpSecret?: string;

  @Prop({ type: Date, select: false })
  pendingTotpEnrollmentExpiresAt?: Date;

  @Prop({
    type: Number,
    default: null,
    min: 0,
    select: false,
    validate: {
      validator: (value: unknown): boolean =>
        value === null || value === undefined || isNonNegativeInteger(value),
    },
  })
  totpLastUsedStep?: number | null;

  @Prop({
    type: [String],
    default: [],
    select: false,
    validate: {
      validator: areValidRecoveryHashes,
      message: 'recoveryCodeHashes phải chứa tối đa 10 hash hợp lệ',
    },
  })
  recoveryCodeHashes!: string[];

  @Prop({
    type: String,
    select: false,
    match: ACTIVATION_GRANT_HASH_PATTERN,
  })
  activationGrantHash?: string;

  @Prop({ type: Date, select: false })
  activationGrantExpiresAt?: Date;

  @Prop({ type: Date, default: null, select: false })
  activationGrantConsumedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lockedAt?: Date | null;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  @Prop({
    type: String,
    enum: AdminAccountDeletionOrigin,
    default: null,
  })
  deletionOrigin?: AdminAccountDeletionOrigin | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminAccountDocument = HydratedDocument<AdminAccount>;

export const AdminAccountSchema = SchemaFactory.createForClass(AdminAccount);

AdminAccountSchema.index(
  { publicId: 1 },
  { name: ADMIN_ACCOUNT_PUBLIC_ID_INDEX, unique: true },
);
AdminAccountSchema.index(
  { email: 1 },
  { name: ADMIN_ACCOUNT_EMAIL_INDEX, unique: true },
);
AdminAccountSchema.index(
  { username: 1 },
  { name: ADMIN_ACCOUNT_USERNAME_INDEX, unique: true },
);
AdminAccountSchema.index(
  { status: 1, role: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_ACCOUNT_LIST_INDEX },
);
AdminAccountSchema.index(
  { createdAt: -1, publicId: 1 },
  { name: ADMIN_ACCOUNT_GLOBAL_LIST_INDEX },
);

AdminAccountSchema.pre('validate', function enforceStateInvariants() {
  try {
    assertAdminAccountState(this);
  } catch (error: unknown) {
    if (!(error instanceof AdminAccountStateInvariantError)) throw error;

    for (const violation of error.violations) {
      this.invalidate(violation.path, violation.message);
    }
  }
});
