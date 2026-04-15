import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, Document } from 'mongoose';

@Schema({ timestamps: true })
export class Reaction extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId; // Người thả tim

  @Prop({ type: Types.ObjectId, ref: 'Post', required: true, index: true })
  postId!: Types.ObjectId; // Bài viết được thả tim

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  postOwnerId!: Types.ObjectId; // Chủ bài viết (Cực kỳ quan trọng để làm Recap nhanh)

  @Prop({ type: String, default: 'heart' })
  emojiType!: string; // Mở rộng nếu sau này có nhiều loại emoji
}

export const ReactionSchema = SchemaFactory.createForClass(Reaction);

// Index kép để 1 người chỉ thả 1 tim/bài và truy vấn cực nhanh
ReactionSchema.index({ userId: 1, postId: 1 }, { unique: true });
// Index để thống kê Recap cho chủ bài viết
ReactionSchema.index({ postOwnerId: 1, createdAt: -1 });
