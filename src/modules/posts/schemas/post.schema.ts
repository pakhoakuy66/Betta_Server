import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true, // Tự động tạo createdAt và updatedAt
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Post extends Document {
  @Prop({
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  publicId!: string;

  // 1. TÁC GIẢ: Liên kết với bảng User
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  authorId!: Types.ObjectId;

  // 2. NỘI DUNG: Dạng text (Mục 3.3 SRS)
  @Prop({
    type: String,
    required: false,
    trim: true,
    maxlength: 2500,
    default: '',
  })
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
    validate: {
      validator: (images: { url: string; publicId: string }[] = []) =>
        images.length <= 3,
      message: 'Bài viết chỉ được phép có tối đa 3 ảnh',
    },
  })
  images!: { url: string; publicId: string }[];

  // 4. THỐNG KÊ (Denormalization - Để load nhanh không cần count)
  @Prop({ type: Number, default: 0 })
  likeCount!: number;

  @Prop({ type: Number, default: 0 })
  shareCount!: number;

  // 5. CƠ CHẾ TỰ XÓA SAU 24 GIỜ
  // expireAt là thời điểm bài viết hết hạn.
  // MongoDB TTL index sẽ tự xóa document khi expireAt <= thời gian hiện tại.
  @Prop({
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    index: { expires: 0 },
  })
  expireAt!: Date;

  // Thêm vào trong Post class
  @Prop({ type: Boolean, default: false })
  isDeletedByAdmin!: boolean; // Để ẩn bài viết nếu vi phạm (dù chưa hết 24h)
}

export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.pre('validate', function () {
  const post = this as Post;
  const hasContent = Boolean(post.content?.trim());
  const hasImages = Array.isArray(post.images) && post.images.length > 0;

  // SRS cho phép chỉ text, chỉ ảnh, hoặc cả hai; nhưng không cho post rỗng.
  if (!hasContent && !hasImages) {
    throw new Error('Bài viết phải có nội dung hoặc ít nhất một ảnh');
  }
});

// Thêm Virtual field để hiển thị thông tin tác giả khi populate
PostSchema.virtual('author', {
  ref: 'User',
  localField: 'authorId',
  foreignField: '_id',
  justOne: true,
});

PostSchema.index({
  authorId: 1,
  createdAt: -1,
  expireAt: 1,
  isDeletedByAdmin: 1,
});

PostSchema.index({
  expireAt: 1,
  isDeletedByAdmin: 1,
  createdAt: -1,
});
