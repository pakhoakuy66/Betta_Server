import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true })
export class Follow {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  followerId!: Types.ObjectId; // Người đi nhấn nút Follow

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  followingId!: Types.ObjectId; // Người được Follow
}

export const FollowSchema = SchemaFactory.createForClass(Follow);
// Tạo index kép để một người không thể follow 1 người khác 2 lần
FollowSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
