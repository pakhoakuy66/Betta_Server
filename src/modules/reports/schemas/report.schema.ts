// report post và account
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Report extends Document {
  // 1. NGƯỜI BÁO CÁO
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporterId!: Types.ObjectId;

  // 2. ĐỐI TƯỢNG BỊ BÁO CÁO (Sử dụng Đa hình)
  @Prop({ type: String, required: true, enum: ['POST', 'USER'], index: true })
  targetType!: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  targetId!: Types.ObjectId; // Có thể là PostId hoặc UserId

  // 3. NỘI DUNG VI PHẠM (Tối ưu cho ReportAccountModal tầng 2)
  @Prop({
    required: true,
    enum: [
      'Đăng nội dung không nên xuất hiện trên Betta',
      'Tài khoản giả mạo ai đó',
      'Vi phạm nội dung', // Cho Post vì Post không có tầng 1
    ],
    default: 'Vi phạm nội dung',
  })
  reasonGroup!: string; // Tương ứng với 'step' (ParentKey) trong FE Account

  @Prop({ required: true })
  reasonDetail!: string; // Chính là 'selectedDetail' hoặc 'selectedReason' cuối cùng

  // 4. TRẠNG THÁI XỬ LÝ
  @Prop({
    default: 'pending',
    enum: ['pending', 'processing', 'resolved', 'dismissed'],
    index: true,
  })
  status!: string;

  // 5. GHI CHÚ CỦA ADMIN (Dành cho nội bộ)
  @Prop({ default: '' })
  adminNote!: string;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

// Index kép: Một người không thể báo cáo cùng 1 nội dung quá nhiều lần trong thời gian ngắn
ReportSchema.index({ reporterId: 1, targetId: 1 }, { unique: true });
