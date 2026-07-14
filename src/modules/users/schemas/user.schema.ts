import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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

  @Prop({ type: String, required: true })
  password!: string;

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
    default: 'active',
    enum: ['active', 'banned', 'reported'],
  })
  status!: string; // Phục vụ tính năng Báo cáo tài khoản (3.15)

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

  // Xử lý Refresh Token (Chuẩn Doanh Nghiệp)
  @Prop({ type: String, default: null, select: false })
  refreshToken?: string | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({
  isDeleted: 1,
  status: 1,
  streakCount: 1,
  _id: 1,
});
