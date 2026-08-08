import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';
import {
  ADMIN_LOGIN_PROTECTION_COLLECTION,
  ADMIN_LOGIN_PROTECTION_KEY_INDEX,
  ADMIN_LOGIN_PROTECTION_MAX_KEY_LOCATORS,
  ADMIN_LOGIN_PROTECTION_TTL_INDEX,
  AdminLoginProtectionScope,
} from '../constants/admin-login-protection.constants';

const KEY_LOCATOR_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,31}):[a-f0-9]{64}$/;

const isNonNegativeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const hasValidUniqueKeyLocators = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= ADMIN_LOGIN_PROTECTION_MAX_KEY_LOCATORS &&
  value.every(
    (entry) => typeof entry === 'string' && KEY_LOCATOR_PATTERN.test(entry),
  ) &&
  new Set(value).size === value.length;

@Schema({
  collection: ADMIN_LOGIN_PROTECTION_COLLECTION,
  strict: 'throw',
  versionKey: false,
})
export class AdminLoginProtection {
  @Prop({
    type: String,
    enum: AdminLoginProtectionScope,
    required: true,
    immutable: true,
  })
  scope!: AdminLoginProtectionScope;

  @Prop({
    type: [String],
    required: true,
    validate: { validator: hasValidUniqueKeyLocators },
  })
  keyLocators!: string[];

  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: { validator: isNonNegativeInteger },
  })
  failedAttempts!: number;

  @Prop({ type: Date, required: true })
  windowStartedAt!: Date;

  @Prop({ type: Date, default: null })
  lockedUntil!: Date | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export type AdminLoginProtectionDocument =
  HydratedDocument<AdminLoginProtection>;
export const AdminLoginProtectionSchema =
  SchemaFactory.createForClass(AdminLoginProtection);

AdminLoginProtectionSchema.index(
  { scope: 1, keyLocators: 1 },
  { name: ADMIN_LOGIN_PROTECTION_KEY_INDEX, unique: true },
);
AdminLoginProtectionSchema.index(
  { expiresAt: 1 },
  { name: ADMIN_LOGIN_PROTECTION_TTL_INDEX, expireAfterSeconds: 0 },
);
