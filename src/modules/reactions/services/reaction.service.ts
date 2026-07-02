import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { RecapService } from '../../recap/services/recap.service';
import { Post } from '../../posts/schemas/post.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { User } from '../../users/schemas/user.schema';
import { Reaction, ReactionType } from '../schemas/reaction.schema';
import { ReactPostDto } from '../dto/react-post.dto';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';

type ReactionPost = {
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  likeCount: number;
};

type ReactionUser = {
  _id: Types.ObjectId;
};

type ReactionCountSnapshot = {
  likeCount: number;
};

@Injectable()
export class ReactionService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(Reaction.name)
    private readonly reactionModel: Model<Reaction>,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,
    private readonly notificationsService: NotificationsService,
    private readonly recapService: RecapService,
  ) {}

  async reactToPost(
    currentUserId: string,
    postPublicId: string,
    dto: ReactPostDto,
  ) {
    const { currentObjectId, post } = await this.assertCanReact(
      currentUserId,
      postPublicId,
    );

    const emojiType = dto.emojiType ?? ReactionType.HEART;
    const session = await this.connection.startSession();

    try {
      let response: {
        reacted: boolean;
        emojiType: ReactionType;
        likeCount: number;
      } | null = null;

      let createdNewReaction = false;

      await session.withTransaction(async () => {
        await this.assertPostStillReactable(post._id, session);

        const writeResult = await this.reactionModel
          .updateOne(
            {
              userId: currentObjectId,
              postId: post._id,
            },
            {
              $set: {
                emojiType,
              },
              $setOnInsert: {
                userId: currentObjectId,
                postId: post._id,
                postOwnerId: post.authorId,
              },
            },
            {
              upsert: true,
              session,
            },
          )
          .exec();

        const didCreateReaction = writeResult.upsertedCount === 1;
        createdNewReaction = didCreateReaction;

        if (didCreateReaction) {
          const updatedPost = await this.postModel
            .findOneAndUpdate(
              {
                _id: post._id,
                expireAt: { $gt: new Date() },
                isDeletedByAdmin: false,
              },
              { $inc: { likeCount: 1 } },
              {
                new: true,
                session,
                projection: { likeCount: 1 },
              },
            )
            .lean<ReactionCountSnapshot>()
            .exec();

          if (!updatedPost) {
            throw new NotFoundException(
              'Bài viết không tồn tại hoặc đã hết hạn',
            );
          }

          response = {
            reacted: true,
            emojiType,
            likeCount: updatedPost.likeCount,
          };

          return;
        }

        const currentPost = await this.getPostReactionCount(post._id, session);

        response = {
          reacted: true,
          emojiType,
          likeCount: currentPost.likeCount,
        };
      });

      if (createdNewReaction) {
        if (!post.authorId.equals(currentObjectId)) {
          void this.notificationsService.createReactionNotification({
            actorId: currentObjectId,
            postOwnerId: post.authorId,
            postId: post._id,
            postPublicId: post.publicId,
          });
        }

        void this.recapService.recordReactionCreatedEvent({
          actorId: currentObjectId,
          postOwnerId: post.authorId,
          postId: post._id,
          postPublicId: post.publicId,
        });
      }

      return {
        success: true,
        message: 'Đã thả tim bài viết',
        data: response,
      };
    } finally {
      await session.endSession();
    }
  }

  async removeReaction(currentUserId: string, postPublicId: string) {
    const { currentObjectId, post } = await this.assertCanReact(
      currentUserId,
      postPublicId,
    );

    const session = await this.connection.startSession();

    try {
      let response: {
        reacted: boolean;
        emojiType: null;
        likeCount: number;
      } | null = null;

      await session.withTransaction(async () => {
        await this.assertPostStillReactable(post._id, session);

        const deletedReaction = await this.reactionModel
          .findOneAndDelete({
            userId: currentObjectId,
            postId: post._id,
          })
          .session(session)
          .exec();

        if (!deletedReaction) {
          const currentPost = await this.getPostReactionCount(
            post._id,
            session,
          );

          response = {
            reacted: false,
            emojiType: null,
            likeCount: currentPost.likeCount,
          };

          return;
        }

        const updatedPost = await this.postModel
          .findOneAndUpdate(
            {
              _id: post._id,
              expireAt: { $gt: new Date() },
              isDeletedByAdmin: false,
              likeCount: { $gt: 0 },
            },
            { $inc: { likeCount: -1 } },
            {
              new: true,
              session,
              projection: { likeCount: 1 },
            },
          )
          .lean<ReactionCountSnapshot>()
          .exec();

        response = {
          reacted: false,
          emojiType: null,
          likeCount: updatedPost?.likeCount ?? 0,
        };
      });

      return {
        success: true,
        message: 'Đã hủy reaction bài viết',
        data: response,
      };
    } finally {
      await session.endSession();
    }
  }

  private async assertCanReact(currentUserId: string, postPublicId: string) {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    if (!isValidPostPublicId(postPublicId)) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();

    const [currentUser, post] = await Promise.all([
      this.userModel
        .findOne({
          _id: currentObjectId,
          isDeleted: false,
          status: 'active',
        })
        .select('_id')
        .lean<ReactionUser>()
        .exec(),
      this.postModel
        .findOne({
          publicId: postPublicId,
          expireAt: { $gt: now },
          isDeletedByAdmin: false,
        })
        .select('_id publicId authorId likeCount')
        .lean<ReactionPost>()
        .exec(),
    ]);

    if (!currentUser || !post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    const isOwner = post.authorId.equals(currentObjectId);

    const [author, blockRecord, relationship] = await Promise.all([
      this.userModel
        .findOne({
          _id: post.authorId,
          isDeleted: false,
          status: 'active',
        })
        .select('_id')
        .lean<ReactionUser>()
        .exec(),

      isOwner
        ? Promise.resolve(null)
        : this.blockModel
            .findOne({
              $or: [
                { blockerId: currentObjectId, blockedId: post.authorId },
                { blockerId: post.authorId, blockedId: currentObjectId },
              ],
            })
            .select('_id')
            .lean()
            .exec(),

      isOwner
        ? Promise.resolve({ _id: currentObjectId })
        : this.relationshipModel
            .findOne({
              followerId: currentObjectId,
              followingId: post.authorId,
            })
            .select('_id')
            .lean()
            .exec(),
    ]);

    if (!author || blockRecord) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    if (!relationship) {
      throw new ForbiddenException(
        'Bạn cần theo dõi người dùng này để reaction bài viết',
      );
    }

    return { currentObjectId, post };
  }

  private async assertPostStillReactable(
    postId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const post = await this.postModel
      .findOne({
        _id: postId,
        expireAt: { $gt: new Date() },
        isDeletedByAdmin: false,
      })
      .select('_id')
      .session(session)
      .lean()
      .exec();

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }
  }

  private async getPostReactionCount(
    postId: Types.ObjectId,
    session: ClientSession,
  ): Promise<ReactionCountSnapshot> {
    const post = await this.postModel
      .findOne({
        _id: postId,
        expireAt: { $gt: new Date() },
        isDeletedByAdmin: false,
      })
      .select('likeCount')
      .session(session)
      .lean<ReactionCountSnapshot>()
      .exec();

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    return post;
  }
}
