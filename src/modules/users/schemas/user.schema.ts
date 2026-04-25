import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true }) // Tự động thêm createdAt, updatedAt
export class User extends Document {
  @Prop({ type: String, required: true, unique: true, index: true })
  username!: string;

  @Prop({ type: String, required: true })
  fullname!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  phone!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  email!: string; 

  @Prop({ type: String, required: true })
  password!: string;

  @Prop({ default: 'user_1_bibjpn' })
  avatarId!: string;

  @Prop({
    default:
      'https://res.cloudinary.com/dulmj9v6i/image/upload/v1774254440/user_1_bibjpn.jpg',
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

  // Các trường cho Forgot Password
  @Prop({ type: String, select: false })
  forgotPasswordOtp?: string;

  @Prop({ type: Date, select: false })
  forgotPasswordExpiry?: Date;

  // Xử lý Refresh Token (Chuẩn Doanh Nghiệp)
  @Prop({ type: String, default: null })
  refreshToken?: string | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
