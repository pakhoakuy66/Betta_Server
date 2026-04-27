import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true, // Tự động lưu ngày tạo để biết Recap thuộc tuần nào
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class WeeklyRecap extends Document {
  // 1. CHỦ SỞ HỮU
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  // 2. ĐỊNH DANH THỜI GIAN (Dùng để truy vấn bản cũ/mới)
  @Prop({ type: Number, required: true })
  weekNumber!: number; // Số tuần trong năm (1-52)

  @Prop({ type: Number, required: true })
  year!: number; // Ví dụ: 2024

  // 3. DỮ LIỆU TỔNG HỢP (Khớp hoàn toàn với UserSlideData trong FE của bạn)
  @Prop({
    type: {
      postsCount: { type: Number, default: 0 }, // Slide ID: "posts"
      heartsGave: { type: Number, default: 0 }, // Slide ID: "gave"
      heartsReceived: { type: Number, default: 0 }, // Slide ID: "received"

      // Lưu danh sách ID để hiển thị Slide "top_receivers" và "top_givers"
      // Chúng ta lưu ID để Backend có thể .populate() lấy Avatar/Name mới nhất
      topGivers: [{ type: Types.ObjectId, ref: 'User' }],
      topReceivers: [{ type: Types.ObjectId, ref: 'User' }],
    },
    _id: false, // Không cần tạo ID riêng cho object stats để nhẹ DB
  })
  stats!: {
    postsCount: number;
    heartsGave: number;
    heartsReceived: number;
    topGivers: Types.ObjectId[];
    topReceivers: Types.ObjectId[];
  };

  // 4. TRẠNG THÁI HIỂN THỊ
  @Prop({ type: Boolean, default: false })
  isSeen!: boolean; // Để FE hiển thị chấm đỏ thông báo tuần mới

  // 5. CƠ CHẾ TỰ HỦY (Tối ưu tài nguyên)
  // Nếu bạn chỉ muốn giữ lại Recap trong 30 ngày để tiết kiệm dung lượng
  @Prop({
    type: Date,
    default: Date.now,
    index: { expires: 2592000 }, // Tự động xóa sau 30 ngày (tính bằng giây)
  })
  expireAt!: Date;
}

export const WeeklyRecapSchema = SchemaFactory.createForClass(WeeklyRecap);

// INDEX CHIẾN THUẬT: Đảm bảo 1 tuần user chỉ có duy nhất 1 bản recap
WeeklyRecapSchema.index(
  { userId: 1, year: -1, weekNumber: -1 },
  { unique: true },
);
