import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post, PostCleanupStatus } from '../../posts/schemas/post.schema';
import { User } from '../../users/schemas/user.schema';
import { UploadsService } from '../../uploads/services/uploads.service';

type ExpiredPostCleanupTarget = {
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  images: { url: string; publicId: string }[];
};

@Injectable()
export class ExpiredPostCleanupService {
  private readonly logger = new Logger(ExpiredPostCleanupService.name);

  private readonly batchSize = 20;
  private readonly lockMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;

  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly uploadsService: UploadsService,
  ) {}

  async cleanupExpiredPosts(): Promise<{
    processed: number;
    deleted: number;
    failed: number;
  }> {
    let processed = 0;
    let deleted = 0;
    let failed = 0;

    for (let index = 0; index < this.batchSize; index += 1) {
      const post = await this.claimNextExpiredPost();

      if (!post) break;

      processed += 1;

      try {
        await this.cleanupOnePost(post);
        deleted += 1;
      } catch (error) {
        failed += 1;
        await this.markCleanupFailed(post._id, error);
      }
    }

    if (processed > 0) {
      this.logger.log(
        `Expired post cleanup finished. processed=${processed}, deleted=${deleted}, failed=${failed}`,
      );
    }

    return { processed, deleted, failed };
  }

  private async claimNextExpiredPost(): Promise<ExpiredPostCleanupTarget | null> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + this.lockMs);

    return this.postModel
      .findOneAndUpdate(
        {
          expireAt: { $lte: now },
          $and: [
            {
              $or: [
                { cleanupAttempts: { $lt: this.maxAttempts } },
                { cleanupAttempts: { $exists: false } },
                { cleanupAttempts: null },
              ],
            },
            {
              $or: [
                { cleanupStatus: PostCleanupStatus.PENDING },
                { cleanupStatus: PostCleanupStatus.FAILED },
                { cleanupStatus: { $exists: false } },
                { cleanupStatus: null },
                { cleanupLockedUntil: { $lte: now } },
                { cleanupLockedUntil: null },
                { cleanupLockedUntil: { $exists: false } },
              ],
            },
          ],
        },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.PROCESSING,
            cleanupLockedUntil: lockUntil,
            cleanupLastError: null,
          },
          $inc: {
            cleanupAttempts: 1,
          },
        },
        {
          sort: { expireAt: 1 },
          new: true,
          projection: {
            _id: 1,
            publicId: 1,
            authorId: 1,
            images: 1,
          },
        },
      )
      .lean<ExpiredPostCleanupTarget>()
      .exec();
  }

  private async cleanupOnePost(post: ExpiredPostCleanupTarget): Promise<void> {
    const imagePublicIds = post.images
      .map((image) => image.publicId)
      .filter(Boolean);

    if (imagePublicIds.length > 0) {
      await this.uploadsService.deleteImages(imagePublicIds, {
        throwOnError: true,
      });
    }

    const deleteResult = await this.postModel
      .deleteOne({
        _id: post._id,
        cleanupStatus: PostCleanupStatus.PROCESSING,
      })
      .exec();

    if (deleteResult.deletedCount !== 1) {
      throw new Error(
        `Expired post cleanup delete skipped for ${post.publicId}`,
      );
    }

    await this.decrementAuthorPostCount(post.authorId, post.publicId);
  }

  private async decrementAuthorPostCount(
    authorId: Types.ObjectId,
    postPublicId: string,
  ): Promise<void> {
    try {
      await this.userModel
        .updateOne(
          { _id: authorId, postsCount: { $gt: 0 } },
          { $inc: { postsCount: -1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Failed to decrement postsCount after expired post cleanup. post=${postPublicId}, author=${authorId.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async markCleanupFailed(
    postId: Types.ObjectId,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(
      `Expired post cleanup failed for post=${postId.toString()}: ${message}`,
      error instanceof Error ? error.stack : undefined,
    );

    await this.postModel
      .updateOne(
        { _id: postId },
        {
          $set: {
            cleanupStatus: PostCleanupStatus.FAILED,
            cleanupLockedUntil: null,
            cleanupLastError: message.slice(0, 500),
          },
        },
      )
      .exec();
  }
}
