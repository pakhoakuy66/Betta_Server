import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  USER_MODERATION_MIGRATABLE_FIELDS,
  USER_MODERATION_MIGRATION_VERSION,
  USER_MODERATION_SCHEMA_VERSION,
  USER_DELETION_ORIGIN_INDEX_NAME,
  USER_RESTRICTION_INDEX_NAME,
  USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  UserDeletionOrigin,
  UserRestrictionType,
  type UserModerationMigratableField,
} from '../constants/user-moderation.constants';

export const DEFAULT_AVATAR_ID = 'user_1_bibjpn';

export type NotificationSettings = {
  enabled: boolean;
  follow: boolean;
  reaction: boolean;
  recap: boolean;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  follow: true,
  reaction: true,
  recap: true,
};

export const DEFAULT_AVATAR_URL =
  'https://res.cloudinary.com/dulmj9v6i/image/upload/v1774254440/user_1_bibjpn.jpg';

export const USER_STATUS = {
  ACTIVE: 'active',
  BANNED: 'banned',
  REPORTED: 'reported',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

const isNonNegativeSafeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isValidRestrictionExpiry = function (
  this: UserRestriction,
  value: Date | null | undefined,
): boolean {
  if (this.type === UserRestrictionType.INDEFINITE_BAN) {
    return value == null;
  }
  return (
    this.type === UserRestrictionType.TEMPORARY_SUSPENSION &&
    value instanceof Date &&
    !Number.isNaN(value.getTime()) &&
    this.effectiveAt instanceof Date &&
    value.getTime() > this.effectiveAt.getTime()
  );
};

@Schema({ _id: false, strict: 'throw' })
export class UserRestriction {
  @Prop({
    type: String,
    enum: Object.values(UserRestrictionType),
    required: true,
  })
  type!: UserRestrictionType;

  @Prop({ type: Date, required: true })
  effectiveAt!: Date;

  @Prop({
    type: Date,
    default: null,
    validate: {
      validator: isValidRestrictionExpiry,
      message: 'Restriction expiry does not match its type',
    },
  })
  expiresAt!: Date | null;

  @Prop({
    type: String,
    required: true,
    match: USER_RESTRICTION_SUPPORT_REFERENCE_PATTERN,
  })
  supportReference!: string;

  @Prop({
    type: String,
    required: true,
    match: USER_RESTRICTION_PUBLIC_REASON_PATTERN,
  })
  publicReasonCode!: string;
}

const UserRestrictionSchema = SchemaFactory.createForClass(UserRestriction);

@Schema({ _id: false, strict: 'throw' })
export class UserModerationMigrationMarker {
  @Prop({
    type: Number,
    required: true,
    enum: [USER_MODERATION_MIGRATION_VERSION],
    immutable: true,
  })
  version!: typeof USER_MODERATION_MIGRATION_VERSION;

  @Prop({ type: Date, required: true, immutable: true })
  migratedAt!: Date;

  @Prop({
    type: [String],
    required: true,
    enum: USER_MODERATION_MIGRATABLE_FIELDS,
    immutable: true,
  })
  ownedFields!: UserModerationMigratableField[];
}

const UserModerationMigrationMarkerSchema = SchemaFactory.createForClass(
  UserModerationMigrationMarker,
);

@Schema({ timestamps: true }) // Tự động thêm createdAt, updatedAt
export class User extends Document {
  @Prop({
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  publicId!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  username!: string;

  @Prop({ type: String, required: true })
  fullname!: string;

  @Prop({ type: String, required: true, unique: true, index: true, trim: true })
  phone!: string;

  @Prop({
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  email!: string;

  @Prop({
    type: String,
    required: false,
    select: false,
    validate: {
      validator: (value: unknown): boolean =>
        value === undefined || (typeof value === 'string' && value.length > 0),
      message: 'Password must be absent or a non-empty hash',
    },
  })
  password?: string;

  @Prop({ default: DEFAULT_AVATAR_ID })
  avatarId!: string;

  @Prop({
    default: DEFAULT_AVATAR_URL,
  })
  avatar!: string;

  @Prop({ type: String, default: '' })
  bio!: string;

  @Prop({ type: String, default: '' })
  link!: string;

  @Prop({ type: Number, default: 0 })
  streakCount!: number;

  @Prop({ type: Date, default: Date.now })
  lastActive!: Date; // Phục vụ tính năng tính toán Streak (3.6)

  // QUẢN LÝ TRẠNG THÁI (Chuẩn doanh nghiệp)
  @Prop({ type: Boolean, default: false })
  isDeleted!: boolean; // Soft Delete

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({
    type: String,
    enum: Object.values(UserDeletionOrigin),
    default: null,
    select: false,
  })
  deletionOrigin!: UserDeletionOrigin | null;

  @Prop({ type: Date, default: null, select: false })
  restorableUntil!: Date | null;

  @Prop({
    type: UserRestrictionSchema,
    default: null,
    select: false,
  })
  restriction!: UserRestriction | null;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: isNonNegativeSafeInteger },
    select: false,
  })
  version!: number;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: isNonNegativeSafeInteger },
    select: false,
  })
  authzVersion!: number;

  @Prop({
    type: Number,
    default: USER_MODERATION_SCHEMA_VERSION,
    enum: [USER_MODERATION_SCHEMA_VERSION],
    select: false,
  })
  moderationSchemaVersion!: typeof USER_MODERATION_SCHEMA_VERSION;

  @Prop({
    type: UserModerationMigrationMarkerSchema,
    default: undefined,
    select: false,
  })
  moderationMigration?: UserModerationMigrationMarker;

  @Prop({
    type: String,
    default: USER_STATUS.ACTIVE,
    enum: Object.values(USER_STATUS),
  })
  status!: UserStatus; // Phục vụ tính năng Báo cáo tài khoản (3.15)

  // CÁC TRƯỜNG METADATA (Dùng để hiển thị nhanh ở Profile)
  @Prop({ type: Number, default: 0 })
  postsCount!: number;

  @Prop({ type: Number, default: 0 })
  followersCount!: number;

  @Prop({ type: Number, default: 0 })
  followingCount!: number;

  /**
   * Internal coordination version for social-graph transactions.
   * Không expose qua API.
   */
  @Prop({
    type: Number,
    default: 0,
    min: 0,
    select: false,
  })
  socialGraphVersion!: number;

  // Số lần đăng nhập sai liên tiếp. Không trả field này qua API mặc định.
  @Prop({
    type: Number,
    default: 0,
    min: 0,
    select: false,
  })
  failedLoginAttempts!: number;

  // Mốc bắt đầu cửa sổ tính các lần đăng nhập sai liên tiếp.
  @Prop({
    type: Date,
    default: null,
    select: false,
  })
  failedLoginWindowStartedAt?: Date | null;

  // Thời điểm tài khoản được phép đăng nhập trở lại.
  @Prop({
    type: Date,
    default: null,
    select: false,
  })
  lockedUntil?: Date | null;

  // Các trường cho Forgot Password
  @Prop({ type: String, select: false })
  forgotPasswordOtp?: string;

  @Prop({ type: Date, select: false })
  forgotPasswordExpiry?: Date;

  // Feild đếm số lần nhập sai OTP
  @Prop({ type: Number, default: 0, select: false })
  forgotPasswordAttempts?: number;

  // Notifications off/on
  @Prop({
    type: {
      enabled: { type: Boolean, default: true },
      follow: { type: Boolean, default: true },
      reaction: { type: Boolean, default: true },
      recap: { type: Boolean, default: true },
    },
    default: DEFAULT_NOTIFICATION_SETTINGS,
    _id: false,
  })
  notificationSettings!: NotificationSettings;
}

export const UserSchema = SchemaFactory.createForClass(User);

export const ADMIN_USER_GLOBAL_LIST_INDEX =
  'admin_user_global_list_v1' as const;
export const ADMIN_USER_FILTERED_LIST_INDEX =
  'admin_user_filtered_list_v1' as const;
export const ADMIN_USER_LOGIN_LOCK_LIST_INDEX =
  'admin_user_login_lock_list_v1' as const;
export const ADMIN_USER_RESTRICTION_LIST_INDEX =
  'admin_user_restriction_list_v1' as const;
export const ADMIN_USER_USERNAME_LIST_INDEX =
  'admin_user_username_list_v1' as const;

UserSchema.index(
  { createdAt: -1, publicId: 1 },
  { name: ADMIN_USER_GLOBAL_LIST_INDEX },
);
UserSchema.index(
  { isDeleted: 1, status: 1, createdAt: -1, publicId: 1 },
  { name: ADMIN_USER_FILTERED_LIST_INDEX },
);
UserSchema.index(
  { lockedUntil: 1, createdAt: -1, publicId: 1 },
  {
    name: ADMIN_USER_LOGIN_LOCK_LIST_INDEX,
    partialFilterExpression: { lockedUntil: { $type: 'date' } },
  },
);
UserSchema.index(
  { 'restriction.type': 1, createdAt: -1, publicId: 1 },
  {
    name: ADMIN_USER_RESTRICTION_LIST_INDEX,
    partialFilterExpression: { 'restriction.type': { $type: 'string' } },
  },
);
UserSchema.index(
  { username: 1, publicId: 1 },
  { name: ADMIN_USER_USERNAME_LIST_INDEX },
);

UserSchema.index({
  isDeleted: 1,
  status: 1,
  streakCount: 1,
  _id: 1,
});
UserSchema.index(
  { 'restriction.type': 1, 'restriction.expiresAt': 1, _id: 1 },
  {
    name: USER_RESTRICTION_INDEX_NAME,
    partialFilterExpression: { 'restriction.type': { $type: 'string' } },
  },
);
UserSchema.index(
  { deletionOrigin: 1, deletedAt: 1, _id: 1 },
  {
    name: USER_DELETION_ORIGIN_INDEX_NAME,
    partialFilterExpression: { deletionOrigin: { $type: 'string' } },
  },
);
