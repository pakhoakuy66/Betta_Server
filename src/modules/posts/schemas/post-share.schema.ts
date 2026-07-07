import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  collection: 'post_shares',
  timestamps: true,
})
export class PostShare extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Post', required: true, index: true })
  postId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  postPublicId!: string;

  @Prop({ type: Number, required: true })
  windowKey!: number;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export const PostShareSchema = SchemaFactory.createForClass(PostShare);

PostShareSchema.index({ userId: 1, postId: 1, windowKey: 1 }, { unique: true });

PostShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
