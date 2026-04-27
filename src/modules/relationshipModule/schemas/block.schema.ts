// src/modules/users/schemas/block.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, Document } from 'mongoose';

@Schema({ timestamps: true })
export class Block extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  blockerId!: Types.ObjectId; // Người thực hiện hành động chặn

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  blockedId!: Types.ObjectId; // Người bị chặn
}

export const BlockSchema = SchemaFactory.createForClass(Block);
// Đảm bảo không thể chặn 1 người 2 lần
BlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });