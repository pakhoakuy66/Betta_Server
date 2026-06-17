import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post } from '../schemas/post.schema';
import { User } from '../../users/schemas/user.schema';
import {
  UploadedImage,
  UploadsService,
} from '../../uploads/services/uploads.service';
import { CreatePostDto } from '../dto/create-post.dto';
import { generatePostPublicId } from '../utils/generate-post-public-id';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { FeedQueryDto } from '../dto/post-query.dto';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type MongoDuplicateError = {
  code?: number;
  keyPattern?: Record<string, number>;
};

type FeedAuthor = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar?: string | null;
  streakCount?: number;
};

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly uploadsService: UploadsService,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,
  ) {}

  async createPost(
    authorId: string,
    dto: CreatePostDto,
    files: UploadFile[] = [],
  ) {
    if (!Types.ObjectId.isValid(authorId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const userObjectId = new Types.ObjectId(authorId);
    const normalizedContent = dto.content?.trim() ?? '';

    const hasContent = normalizedContent.length > 0;
    const hasImages = files.length > 0;

    if (!hasContent && !hasImages) {
      throw new BadRequestException(
        'Bài viết phải có nội dung hoặc ít nhất một ảnh',
      );
    }

    const author = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select('_id')
      .lean()
      .exec();

    if (!author) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    let uploadedImages: UploadedImage[] = [];
    let createdPost: Post | null = null;

    try {
      uploadedImages = await this.uploadsService.uploadPostImages(files);

      createdPost = await this.createPostWithPublicId({
        authorId: userObjectId,
        content: normalizedContent,
        images: uploadedImages.map((image) => ({
          url: image.url,
          publicId: image.publicId,
        })),
      });

      await this.userModel.updateOne(
        { _id: userObjectId },
        { $inc: { postsCount: 1 } },
      );

      return {
        success: true,
        message: 'Tạo bài viết thành công',
        data: this.toPostResponse(createdPost),
      };
    } catch (error) {
      if (createdPost?._id) {
        await this.postModel.deleteOne({ _id: createdPost._id });
      }

      if (uploadedImages.length > 0) {
        await this.uploadsService.deleteImages(
          uploadedImages.map((image) => image.publicId),
        );
      }

      throw error;
    }
  }

  async getFeed(currentUserId: string, query: FeedQueryDto) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const userObjectId = new Types.ObjectId(currentUserId);
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select('_id')
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    const [relationships, blocks] = await Promise.all([
      this.relationshipModel
        .find({ followerId: userObjectId })
        .select('followingId')
        .lean()
        .exec(),

      this.blockModel
        .find({
          $or: [{ blockerId: userObjectId }, { blockedId: userObjectId }],
        })
        .select('blockerId blockedId')
        .lean()
        .exec(),
    ]);

    const blockedUserIds = new Set(
      blocks.map((block) => {
        const blockerId = block.blockerId.toString();
        const blockedId = block.blockedId.toString();

        return blockerId === currentUserId ? blockedId : blockerId;
      }),
    );

    const candidateAuthorIds = [
      userObjectId,
      ...relationships
        .map((relationship) => relationship.followingId)
        .filter((followingId) => !blockedUserIds.has(followingId.toString())),
    ];

    const activeAuthors = await this.userModel
      .find({
        _id: { $in: candidateAuthorIds },
        isDeleted: false,
        status: 'active',
      })
      .select('_id publicId username fullname avatar streakCount')
      .lean()
      .exec();

    const activeAuthorIds = activeAuthors.map((author) => author._id);
    const authorMap = new Map<string, FeedAuthor>(
      activeAuthors.map((author) => [
        author._id.toString(),
        {
          _id: author._id,
          publicId: author.publicId,
          username: author.username,
          fullname: author.fullname,
          avatar: author.avatar ?? null,
          streakCount: author.streakCount ?? 0,
        },
      ]),
    );

    const posts = await this.postModel
      .find({
        authorId: { $in: activeAuthorIds },
        expireAt: { $gt: new Date() },
        isDeletedByAdmin: false,
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .exec();

    const hasMore = posts.length > limit;
    const pagePosts = hasMore ? posts.slice(0, limit) : posts;

    return {
      success: true,
      data: pagePosts.map((post) => this.toFeedPostResponse(post, authorMap)),
      pagination: {
        page,
        limit,
        hasMore,
      },
    };
  }

  private async createPostWithPublicId(data: {
    authorId: Types.ObjectId;
    content: string;
    images: { url: string; publicId: string }[];
  }) {
    const MAX_PUBLIC_ID_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_PUBLIC_ID_RETRIES; attempt += 1) {
      try {
        return await this.postModel.create({
          ...data,
          publicId: generatePostPublicId(),
        });
      } catch (error) {
        const mongoError = error as MongoDuplicateError;

        if (
          mongoError.code === 11000 &&
          mongoError.keyPattern?.publicId &&
          attempt < MAX_PUBLIC_ID_RETRIES
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new BadRequestException('Không thể tạo mã định danh cho bài viết');
  }

  private toPostResponse(post: Post) {
    return {
      id: post.publicId,
      publicId: post.publicId,
      content: post.content,
      images: post.images.map((image) => ({
        url: image.url,
        publicId: image.publicId,
      })),
      likeCount: post.likeCount,
      shareCount: post.shareCount,
      expireAt: post.expireAt,
      isDeletedByAdmin: post.isDeletedByAdmin,
      createdAt: post.get('createdAt') as Date,
      updatedAt: post.get('updatedAt') as Date,
    };
  }

  private toFeedPostResponse(post: Post, authorMap: Map<string, FeedAuthor>) {
    const author = authorMap.get(post.authorId.toString());

    return {
      id: post.publicId,
      publicId: post.publicId,
      content: post.content,
      images: post.images.map((image) => ({
        url: image.url,
        publicId: image.publicId,
      })),
      likeCount: post.likeCount,
      shareCount: post.shareCount,
      expireAt: post.expireAt,
      createdAt: post.get('createdAt') as Date,
      author: author
        ? {
            id: author._id.toString(),
            publicId: author.publicId,
            username: author.username,
            fullname: author.fullname,
            avatar: author.avatar ?? null,
            streakCount: author.streakCount ?? 0,
          }
        : null,
    };
  }
}
