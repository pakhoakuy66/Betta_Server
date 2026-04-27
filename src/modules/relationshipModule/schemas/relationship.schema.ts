import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Relationship extends Document {
  // Người bấm nút Follow
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  followerId!: Types.ObjectId;

  // Người được Follow
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  followingId!: Types.ObjectId;
}

// Tạo Compound Index để đảm bảo 1 người chỉ có thể Follow người kia 1 lần duy nhất
export const RelationshipSchema = SchemaFactory.createForClass(Relationship);
RelationshipSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
