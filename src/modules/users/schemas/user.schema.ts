import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true }) // Tự động thêm createdAt, updatedAt
export class User extends Document {
  @Prop({ required: true, unique: true, index: true })
  username!: string;

  @Prop({ required: true })
  fullname!: string;

  @Prop({ default: 'user_1_bibjpn' })
  avatarId!: string;

  @Prop({
    default:
      'https://res.cloudinary.com/dulmj9v6i/image/upload/v1774254440/user_1_bibjpn.jpg',
  })
  avatar!: string;

  @Prop({ default: '' })
  bio!: string;

  @Prop({ default: '' })
  link!: string;

  @Prop({ default: 0 })
  streakCount!: number;

  @Prop({ default: Date.now })
  lastActive!: Date; // Phục vụ tính năng tính toán Streak (3.6)

  // QUẢN LÝ TRẠNG THÁI (Chuẩn doanh nghiệp)
  @Prop({ default: false })
  isDeleted!: boolean; // Soft Delete

  @Prop()
  deletedAt?: Date;

  @Prop({ default: 'active', enum: ['active', 'banned', 'reported'] })
  status!: string; // Phục vụ tính năng Báo cáo tài khoản (3.15)

  // CÁC TRƯỜNG METADATA (Dùng để hiển thị nhanh ở Profile)
  @Prop({ default: 0 })
  postsCount!: number;

  @Prop({ default: 0 })
  followersCount!: number;

  @Prop({ default: 0 })
  followingCount!: number;
}

export const UserSchema = SchemaFactory.createForClass(User);
