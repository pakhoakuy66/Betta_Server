import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class SystemReport extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporterId!: Types.ObjectId;

  // Nội dung chi tiết lỗi (Content từ textarea của bạn)
  @Prop({ type: String, required: true, trim: true })
  description!: string;

  // Lưu thông tin file đính kèm (Cloudinary URL)
  @Prop({
    type: {
      url: { type: String },
      publicId: { type: String }, // Để xóa ảnh nếu cần
    },
    default: null,
  })
  evidence?: { url: string; publicId: string };

  @Prop({
    default: 'pending',
    enum: ['pending', 'investigating', 'fixed', 'closed'],
    index: true,
  })
  status!: string;

  @Prop({ default: '' })
  adminNote!: string;
}

export const SystemReportSchema = SchemaFactory.createForClass(SystemReport);
