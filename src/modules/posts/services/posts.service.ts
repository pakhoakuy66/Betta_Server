import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { StreakService } from '../../streak/services/streak.service';
import { RecapService } from '../../recap/services/recap.service';
import { CreatePostDto } from '../dto/create-post.dto';
import {
  generatePostPublicId,
  isValidPostPublicId,
} from '../utils/generate-post-public-id';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Reaction } from '../../reactions/schemas/reaction.schema';
import { PostShare } from '../schemas/post-share.schema';
import { FeedQueryDto, ProfilePostsQueryDto } from '../dto/post-query.dto';
import { buildEligibleUserMatch } from '../../users/policies/user-eligibility.policy';

const POST_SHARE_WINDOW_MS = 10 * 60 * 1000;

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

type PostAuthor = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string | null;
  streakCount: number;
};

type PublicPostAuthor = {
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string | null;
  streakCount: number;
};

type PublicPostResponse = {
  id: string;
  publicId: string;
  content: string;
  images: { url: string; publicId: string }[];
  likeCount: number;
  shareCount: number;
  isReacted?: boolean;
  expireAt: Date;
  createdAt: Date;
  updatedAt?: Date;
  author?: PublicPostAuthor | null;
};

type PostListItem = {
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  content: string;
  images: { url: string; publicId: string }[];
  likeCount: number;
  shareCount: number;
  expireAt: Date;
  createdAt: Date;
};

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly uploadsService: UploadsService,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,
    @InjectModel(Reaction.name)
    private readonly reactionModel: Model<Reaction>,
    @InjectModel(PostShare.name)
    private readonly postShareModel: Model<PostShare>,
    private readonly streakService: StreakService,
    private readonly recapService: RecapService,
  ) {}

  async createPost(
    authorId: string,
    dto: CreatePostDto,
    files: UploadFile[] = [],
    idempotencyKey?: string,
  ) {
    if (!Types.ObjectId.isValid(authorId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const userObjectId = new Types.ObjectId(authorId);
    const now = new Date();
    const normalizedContent = dto.content?.trim() ?? '';
    const normalizedIdempotencyKey =
      this.normalizeIdempotencyKey(idempotencyKey);

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
        ...buildEligibleUserMatch(now),
      })
      .select('_id')
      .lean()
      .exec();

    if (!author) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    const existingPost = await this.findPostByIdempotencyKey(
      userObjectId,
      normalizedIdempotencyKey,
    );

    if (existingPost) {
      return {
        success: true,
        message: 'Tạo bài viết thành công',
        data: this.toPostResponse(existingPost),
      };
    }

    let uploadedImages: UploadedImage[] = [];
    let createdPost: Post | null = null;

    try {
      uploadedImages = await this.uploadsService.uploadPostImages(files);

      createdPost = await this.createPostWithPublicId({
        authorId: userObjectId,
        content: normalizedContent,
        idempotencyKey: normalizedIdempotencyKey,
        images: uploadedImages.map((image) => ({
          url: image.url,
          publicId: image.publicId,
        })),
      });

      const postCreatedAt =
        (createdPost.get('createdAt') as Date) ?? new Date();

      await this.userModel
        .updateOne(
          { _id: userObjectId },
          {
            $inc: { postsCount: 1 },
            $set: { lastActive: postCreatedAt },
          },
        )
        .exec();

      await this.streakService.recordPostCreated(userObjectId, postCreatedAt);

      await this.recapService.recordPostCreatedEvent({
        actorId: userObjectId,
        postId: createdPost._id,
        postPublicId: createdPost.publicId,
        occurredAt: postCreatedAt,
      });

      return {
        success: true,
        message: 'Tạo bài viết thành công',
        data: this.toPostResponse(createdPost),
      };
    } catch (error) {
      if (this.isIdempotencyDuplicate(error)) {
        if (uploadedImages.length > 0) {
          await this.deleteDuplicateUploadedImages(uploadedImages);
          uploadedImages = [];
        }

        const existingPost = await this.findPostByIdempotencyKey(
          userObjectId,
          normalizedIdempotencyKey,
        );

        if (existingPost) {
          return {
            success: true,
            message: 'Tạo bài viết thành công',
            data: this.toPostResponse(existingPost),
          };
        }
      }

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

  async deletePost(currentUserId: string, publicId: string) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    if (!isValidPostPublicId(publicId)) {
      throw new NotFoundException('Bài viết không tồn tại');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();

    const currentUser = await this.userModel
      .findOne({
        _id: currentObjectId,
        ...buildEligibleUserMatch(now),
      })
      .select('_id')
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    /*
     * authorId nằm trong filter để đảm bảo chỉ chủ bài viết mới xóa được.
     * Trả cùng một lỗi 404 cho post không tồn tại và post không thuộc sở hữu,
     * tránh làm lộ tài nguyên của user khác.
     */
    const deletedPost = await this.postModel
      .findOneAndDelete({
        publicId,
        authorId: currentObjectId,
      })
      .exec();

    if (!deletedPost) {
      throw new NotFoundException(
        'Bài viết không tồn tại hoặc bạn không có quyền xóa',
      );
    }

    await this.decrementPostCount(currentObjectId);

    /*
     * Post đã bị xóa khỏi MongoDB trước khi cleanup Cloudinary.
     * Nếu Cloudinary lỗi, UploadsService sẽ log lỗi nhưng không làm post xuất
     * hiện trở lại hoặc khiến client hiểu nhầm rằng thao tác xóa thất bại.
     */
    await this.uploadsService.deleteImages(
      deletedPost.images.map((image) => image.publicId),
    );

    return {
      success: true,
      message: 'Xóa bài viết thành công',
    };
  }

  async getFeed(currentUserId: string, query: FeedQueryDto) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const userObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        ...buildEligibleUserMatch(now),
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
        ...buildEligibleUserMatch(now),
      })
      .select('_id publicId username fullname avatar streakCount')
      .lean()
      .exec();

    const activeAuthorIds = activeAuthors.map((author) => author._id);
    const authorMap = new Map<string, PostAuthor>(
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
        expireAt: { $gt: now },
        isDeletedByAdmin: false,
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .lean<PostListItem[]>()
      .exec();

    const hasMore = posts.length > limit;
    const pagePosts = hasMore ? posts.slice(0, limit) : posts;

    const reactedPostIds = await this.getReactedPostIdSet(
      userObjectId,
      pagePosts.map((post) => post._id),
    );

    return {
      success: true,
      data: pagePosts.map((post) =>
        this.toFeedPostResponse(post, authorMap, reactedPostIds),
      ),
      pagination: {
        page,
        limit,
        hasMore,
      },
    };
  }

  async getProfilePosts(
    currentUserId: string,
    username: string,
    query: ProfilePostsQueryDto,
  ) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const normalizedUsername = username.trim();

    if (!normalizedUsername) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;
    const now = new Date();

    const [currentUser, profileUser] = await Promise.all([
      this.userModel
        .findOne({
          _id: currentObjectId,
          ...buildEligibleUserMatch(now),
        })
        .select('_id')
        .lean()
        .exec(),

      this.userModel
        .findOne({
          username: normalizedUsername,
          ...buildEligibleUserMatch(now),
        })
        .select('_id publicId username fullname avatar streakCount')
        .lean()
        .exec(),
    ]);

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    if (!profileUser) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const isOwner = profileUser._id.toString() === currentUserId;

    const blockRecord = await this.blockModel
      .findOne({
        $or: [
          { blockerId: currentObjectId, blockedId: profileUser._id },
          { blockerId: profileUser._id, blockedId: currentObjectId },
        ],
      })
      .select('_id')
      .lean()
      .exec();

    if (blockRecord) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    if (!isOwner) {
      const relationship = await this.relationshipModel
        .findOne({
          followerId: currentObjectId,
          followingId: profileUser._id,
        })
        .select('_id')
        .lean()
        .exec();

      if (!relationship) {
        throw new ForbiddenException(
          'Bạn cần theo dõi người dùng này để xem bài viết',
        );
      }
    }

    const posts = await this.postModel
      .find({
        authorId: profileUser._id,
        expireAt: { $gt: now },
        isDeletedByAdmin: false,
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .lean<PostListItem[]>()
      .exec();

    const hasMore = posts.length > limit;
    const pagePosts = hasMore ? posts.slice(0, limit) : posts;

    const reactedPostIds = await this.getReactedPostIdSet(
      currentObjectId,
      pagePosts.map((post) => post._id),
    );

    const authorMap = new Map<string, PostAuthor>([
      [
        profileUser._id.toString(),
        {
          _id: profileUser._id,
          publicId: profileUser.publicId,
          username: profileUser.username,
          fullname: profileUser.fullname,
          avatar: profileUser.avatar ?? null,
          streakCount: profileUser.streakCount ?? 0,
        },
      ],
    ]);

    return {
      success: true,
      data: pagePosts.map((post) =>
        this.toFeedPostResponse(post, authorMap, reactedPostIds),
      ),
      pagination: {
        page,
        limit,
        hasMore,
      },
    };
  }

  async getPostDetail(currentUserId: string, publicId: string) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    if (!isValidPostPublicId(publicId)) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();

    const [currentUser, post] = await Promise.all([
      this.userModel
        .findOne({
          _id: currentObjectId,
          ...buildEligibleUserMatch(now),
        })
        .select('_id')
        .lean()
        .exec(),

      this.postModel
        .findOne({
          publicId,
          expireAt: { $gt: now },
          isDeletedByAdmin: false,
        })
        .exec(),
    ]);

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const isOwner = post.authorId.toString() === currentUserId;

    const [author, blockRecord] = await Promise.all([
      this.userModel
        .findOne({
          _id: post.authorId,
          ...buildEligibleUserMatch(now),
        })
        .select('_id publicId username fullname avatar streakCount')
        .lean()
        .exec(),

      this.blockModel
        .findOne({
          $or: [
            { blockerId: currentObjectId, blockedId: post.authorId },
            { blockerId: post.authorId, blockedId: currentObjectId },
          ],
        })
        .select('_id')
        .lean()
        .exec(),
    ]);

    if (!author || blockRecord) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    if (!isOwner) {
      const relationship = await this.relationshipModel
        .findOne({
          followerId: currentObjectId,
          followingId: post.authorId,
        })
        .select('_id')
        .lean()
        .exec();

      if (!relationship) {
        throw new ForbiddenException(
          'Bạn cần theo dõi người dùng này để xem bài viết',
        );
      }
    }

    const reactedPostIds = await this.getReactedPostIdSet(currentObjectId, [
      post._id,
    ]);

    return {
      success: true,
      data: this.toPostDetailResponse(post, author, reactedPostIds),
    };
  }

  async recordPostShare(currentUserId: string, publicId: string) {
    const { currentObjectId, post } = await this.findVisiblePostForCurrentUser(
      currentUserId,
      publicId,
    );

    const now = new Date();
    const windowKey = Math.floor(now.getTime() / POST_SHARE_WINDOW_MS);
    const expiresAt = new Date(now.getTime() + POST_SHARE_WINDOW_MS);

    const counted = await this.tryCreatePostShareWindow({
      userId: currentObjectId,
      postId: post._id,
      postPublicId: post.publicId,
      windowKey,
      expiresAt,
    });

    if (!counted) {
      const shareCount = await this.getCurrentPostShareCount(post._id);

      return {
        success: true,
        message: 'Đã ghi nhận chia sẻ bài viết',
        data: {
          counted: false,
          shareCount,
        },
      };
    }

    const updatedPost = await this.postModel
      .findOneAndUpdate(
        {
          _id: post._id,
          expireAt: { $gt: new Date() },
          isDeletedByAdmin: false,
        },
        { $inc: { shareCount: 1 } },
        { returnDocument: 'after' },
      )
      .select('shareCount')
      .lean<{ shareCount: number }>()
      .exec();

    if (!updatedPost) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    return {
      success: true,
      message: 'Đã ghi nhận chia sẻ bài viết',
      data: {
        counted: true,
        shareCount: updatedPost.shareCount,
      },
    };
  }

  private async createPostWithPublicId(data: {
    authorId: Types.ObjectId;
    content: string;
    idempotencyKey: string | null;
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

  private normalizeIdempotencyKey(idempotencyKey?: string): string | null {
    const normalizedKey = idempotencyKey?.trim();

    if (!normalizedKey) return null;

    const isValidKey = /^[A-Za-z0-9_-]{16,80}$/.test(normalizedKey);

    if (!isValidKey) {
      throw new BadRequestException('Idempotency-Key không hợp lệ');
    }

    return normalizedKey;
  }

  private isIdempotencyDuplicate(error: unknown): boolean {
    const mongoError = error as MongoDuplicateError;

    return (
      mongoError.code === 11000 &&
      Boolean(mongoError.keyPattern?.idempotencyKey)
    );
  }

  private async findPostByIdempotencyKey(
    authorId: Types.ObjectId,
    idempotencyKey: string | null,
  ): Promise<Post | null> {
    if (!idempotencyKey) return null;

    return this.postModel
      .findOne({
        authorId,
        idempotencyKey,
      })
      .exec();
  }

  private async deleteDuplicateUploadedImages(
    uploadedImages: UploadedImage[],
  ): Promise<void> {
    try {
      await this.uploadsService.deleteImages(
        uploadedImages.map((image) => image.publicId),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Failed to cleanup duplicate post images: ${message}`);
    }
  }

  private async tryCreatePostShareWindow(data: {
    userId: Types.ObjectId;
    postId: Types.ObjectId;
    postPublicId: string;
    windowKey: number;
    expiresAt: Date;
  }): Promise<boolean> {
    try {
      const result = await this.postShareModel
        .updateOne(
          {
            userId: data.userId,
            postId: data.postId,
            windowKey: data.windowKey,
          },
          {
            $setOnInsert: data,
          },
          { upsert: true },
        )
        .exec();

      return result.upsertedCount > 0;
    } catch (error) {
      const mongoError = error as MongoDuplicateError;

      if (mongoError.code === 11000) {
        return false;
      }

      throw error;
    }
  }

  private async findVisiblePostForCurrentUser(
    currentUserId: string,
    publicId: string,
  ): Promise<{ currentObjectId: Types.ObjectId; post: Post }> {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    if (!isValidPostPublicId(publicId)) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();

    const [currentUser, post] = await Promise.all([
      this.userModel
        .findOne({ _id: currentObjectId, ...buildEligibleUserMatch(now) })
        .select('_id')
        .lean()
        .exec(),

      this.postModel
        .findOne({
          publicId,
          expireAt: { $gt: now },
          isDeletedByAdmin: false,
        })
        .exec(),
    ]);

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const isOwner = post.authorId.equals(currentObjectId);

    const [author, blockRecord] = await Promise.all([
      this.userModel
        .findOne({ _id: post.authorId, ...buildEligibleUserMatch(now) })
        .select('_id')
        .lean()
        .exec(),

      this.blockModel
        .findOne({
          $or: [
            { blockerId: currentObjectId, blockedId: post.authorId },
            { blockerId: post.authorId, blockedId: currentObjectId },
          ],
        })
        .select('_id')
        .lean()
        .exec(),
    ]);

    if (!author || blockRecord) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    if (!isOwner) {
      const relationship = await this.relationshipModel
        .findOne({
          followerId: currentObjectId,
          followingId: post.authorId,
        })
        .select('_id')
        .lean()
        .exec();

      if (!relationship) {
        throw new ForbiddenException(
          'Bạn cần theo dõi người dùng này để chia sẻ bài viết',
        );
      }
    }

    return { currentObjectId, post };
  }

  private toPublicPostAuthor(author: PostAuthor): PublicPostAuthor {
    return {
      id: author.publicId,
      publicId: author.publicId,
      username: author.username,
      fullname: author.fullname,
      avatar: author.avatar ?? null,
      streakCount: author.streakCount ?? 0,
    };
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
      createdAt: post.get('createdAt') as Date,
      updatedAt: post.get('updatedAt') as Date,
    };
  }

  private async decrementPostCount(userId: Types.ObjectId): Promise<void> {
    try {
      const result = await this.userModel
        .updateOne(
          {
            _id: userId,
            postsCount: { $gt: 0 },
          },
          {
            $inc: { postsCount: -1 },
          },
        )
        .exec();

      if (result.matchedCount === 0) {
        this.logger.warn(
          `postsCount was not decremented for user ${userId.toString()}: user not found or postsCount already equals 0`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      /*
       * Post đã được xóa thành công. Không trả 500 vì postsCount là dữ liệu
       * denormalized và có thể được đồng bộ lại bằng maintenance job.
       */
      this.logger.warn(
        `Failed to decrement postsCount for user ${userId.toString()}: ${message}`,
      );
    }
  }

  private toFeedPostResponse(
    post: PostListItem,
    authorMap: Map<string, PostAuthor>,
    reactedPostIds: Set<string>,
  ): PublicPostResponse {
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
      isReacted: reactedPostIds.has(post._id.toString()),
      expireAt: post.expireAt,
      createdAt: post.createdAt,
      author: author ? this.toPublicPostAuthor(author) : null,
    };
  }

  private toPostDetailResponse(
    post: Post,
    author: PostAuthor,
    reactedPostIds: Set<string>,
  ): PublicPostResponse {
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
      isReacted: reactedPostIds.has(post._id.toString()),
      expireAt: post.expireAt,
      createdAt: post.get('createdAt') as Date,
      updatedAt: post.get('updatedAt') as Date,
      author: this.toPublicPostAuthor(author),
    };
  }

  private async getCurrentPostShareCount(
    postId: Types.ObjectId,
  ): Promise<number> {
    const post = await this.postModel
      .findOne({
        _id: postId,
        expireAt: { $gt: new Date() },
        isDeletedByAdmin: false,
      })
      .select('shareCount')
      .lean<{ shareCount: number }>()
      .exec();

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    return post.shareCount;
  }

  private async getReactedPostIdSet(
    currentUserId: Types.ObjectId,
    postIds: Types.ObjectId[],
  ): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();

    const reactions = await this.reactionModel
      .find({
        userId: currentUserId,
        postId: { $in: postIds },
      })
      .select('postId')
      .lean<{ postId: Types.ObjectId }[]>()
      .exec();

    return new Set(reactions.map((reaction) => reaction.postId.toString()));
  }
}
