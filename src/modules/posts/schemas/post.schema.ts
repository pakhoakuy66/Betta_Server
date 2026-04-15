import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true, // Tự động tạo createdAt và updatedAt
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Post extends Document {
  // 1. TÁC GIẢ: Liên kết với bảng User
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  authorId!: Types.ObjectId;

  // 2. NỘI DUNG: Dạng text (Mục 3.3 SRS)
  @Prop({ type: String, required: true, trim: true })
  content!: string;

  // 3. HÌNH ẢNH: Lưu mảng các URL (Cloudinary)
  @Prop({
    type: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true }, // Dùng để xóa ảnh trên Cloudinary
      },
    ],
    default: [],
  })
  images!: { url: string; publicId: string }[];

  // 4. THỐNG KÊ (Denormalization - Để load nhanh không cần count)
  @Prop({ type: Number, default: 0 })
  likeCount!: number;

  @Prop({ type: Number, default: 0 })
  shareCount!: number;

  // 5. CƠ CHẾ TỰ XÓA SAU 24 GIỜ (Mục 3.3 SRS)
  // Field này sẽ được gán giá trị = thời điểm tạo bài viết.
  // MongoDB sẽ tự xóa record này sau 86400 giây (24h)
  @Prop({
    type: Date,
    default: Date.now,
    index: { expires: 86400 }, // 24 giờ tính bằng giây
  })
  expireAt!: Date;

  // Thêm vào trong Post class
  @Prop({ type: Boolean, default: false })
  isDeletedByAdmin!: boolean; // Để ẩn bài viết nếu vi phạm (dù chưa hết 24h)
}

export const PostSchema = SchemaFactory.createForClass(Post);

// Thêm Virtual field để hiển thị thông tin tác giả khi populate
PostSchema.virtual('author', {
  ref: 'User',
  localField: 'authorId',
  foreignField: '_id',
  justOne: true,
});
