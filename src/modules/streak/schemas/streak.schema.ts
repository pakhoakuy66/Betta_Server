import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true,
  collection: 'streak_histories',
})
export class StreakHistory extends Document {
  // 1. LIÊN KẾT NGƯỜI DÙNG
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  // 2. NGÀY GHI NHẬN (Định dạng: YYYY-MM-DD)
  // Việc lưu string giúp Cron Job truy vấn cực nhanh mà không bị lệch múi giờ (Timezone)
  @Prop({ type: String, required: true, index: true })
  date!: string;

  // 3. TRẠNG THÁI GIỮ CHUỖI
  @Prop({ type: Boolean, default: false })
  hasPosted!: boolean;

  // 4. BIẾN ĐỘNG ĐIỂM SỐ TRONG NGÀY
  // Lưu số điểm cộng thêm hoặc bị trừ (âm) trong ngày này
  @Prop({ type: Number, default: 0 })
  pointsChanged!: number;

  // 5. CHỈ SỐ STREAK TẠI THỜI ĐIỂM ĐÓ
  // Lưu lại để có thể vẽ biểu đồ tăng trưởng Streak nếu cần
  @Prop({ type: Number, default: 0 })
  currentStreakCount!: number;
}

export const StreakHistorySchema = SchemaFactory.createForClass(StreakHistory);

// Ràng buộc: Một người dùng chỉ có duy nhất 1 bản ghi lịch sử cho 1 ngày
StreakHistorySchema.index({ userId: 1, date: 1 }, { unique: true });
StreakHistorySchema.index({ createdAt: 1 });
