import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Notification extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  recipientId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: ['REACTION', 'RECAP', 'EXPIRING', 'FOLLOW'],
    index: true,
  })
  type!: string;

  // Danh sách ID người tương tác để hiển thị avatar nhóm (max 3-5 người)
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }] })
  actorIds!: Types.ObjectId[];

  @Prop({ type: Number, default: 0 })
  otherCount!: number;

  @Prop({ type: String, required: true })
  content!: string;

  @Prop({ type: Types.ObjectId })
  targetId?: Types.ObjectId;

  @Prop({ type: Boolean, default: false, index: true })
  isRead!: boolean;

  /**
   * CƠ CHẾ TỰ HỦY (TTL INDEX)
   * 14 ngày = 14 * 24 * 60 * 60 = 1,209,600 giây
   */
  @Prop({
    type: Date,
    default: Date.now,
    index: { expires: 1209600 },
  })
  expireAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// Index tối ưu truy vấn danh sách thông báo mới nhất
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
