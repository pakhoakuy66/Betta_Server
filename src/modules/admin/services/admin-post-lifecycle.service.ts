import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, Types } from 'mongoose';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  CanonicalModerationReasonCode,
  ModerationReasonTarget,
} from '../../../common/moderation/moderation-reason.constants';
import {
  getCanonicalModerationReason,
  normalizeModerationReasonDetail,
} from '../../../common/moderation/moderation-reason.policy';
import {
  Post,
  PostCleanupStatus,
  PostModerationState,
} from '../../posts/schemas/post.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import { buildEligibleUserMatch } from '../../users/policies/user-eligibility.policy';
import { User } from '../../users/schemas/user.schema';
import {
  ADMIN_POST_MODERATION_AGGREGATE_TYPE,
  ADMIN_POST_MODERATION_EVENT_TYPE,
  ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH,
  ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH,
  AdminPostModerationOperation,
  getAdminPostModerationReasonAction,
} from '../constants/admin-post-moderation.constants';
import type {
  AdminPostModerationTransition,
  AdminPostModerationTransitionInput,
  EnqueueAdminPostTransitionInput,
} from '../interfaces/admin-post-moderation.interface';

type StoredPost = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  images: readonly Readonly<{ url?: string; publicId?: string }>[];
  expireAt: Date;
  isDeletedByAdmin: boolean;
  moderationState?: PostModerationState;
  moderationVersion?: number;
}>;

const POST_PROJECTION =
  '_id publicId authorId images expireAt isDeletedByAdmin ' +
  '+moderationState +moderationVersion';

@Injectable()
export class AdminPostLifecycleService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly outbox: OutboxService,
  ) {}

  async transition(
    input: AdminPostModerationTransitionInput,
    mongoSession: ClientSession,
    now: Date = new Date(),
  ): Promise<AdminPostModerationTransition> {
    this.assertInput(input);
    const reason = getCanonicalModerationReason(
      ModerationReasonTarget.POST,
      getAdminPostModerationReasonAction(input.operation),
      input.reasonCode,
    );
    if (!reason?.publicReasonCode || !reason.publicMessage) {
      throw new BadRequestException('Reason code không hợp lệ cho Post action');
    }
    if (input.reasonNote !== undefined) {
      const normalized = normalizeModerationReasonDetail(
        input.reasonNote,
        ADMIN_POST_MODERATION_REASON_NOTE_MIN_LENGTH,
        ADMIN_POST_MODERATION_REASON_NOTE_MAX_LENGTH,
      );
      if (!normalized) {
        throw new BadRequestException('Reason note không hợp lệ');
      }
    }

    const post = await this.load(input, mongoSession);
    if (!post) throw new NotFoundException('Không tìm thấy Post');
    this.assertTransition(post, input, now);
    if (input.operation === AdminPostModerationOperation.RESTORE) {
      await this.assertRestorable(post, mongoSession, now);
    }

    const beforeState = this.state(post);
    const beforeVersion = post.moderationVersion ?? 0;
    const afterState = this.afterState(input.operation);
    const updated = await this.posts
      .findOneAndUpdate(
        this.casFilter(post, input, now),
        this.transitionUpdate(input, reason.code, afterState, now),
        { session: mongoSession, returnDocument: 'after', runValidators: true },
      )
      .select(POST_PROJECTION)
      .lean<StoredPost | null>()
      .exec();
    if (!updated) throw this.staleConflict();

    return Object.freeze({
      postId: updated._id,
      postPublicId: updated.publicId,
      authorId: updated.authorId,
      beforeState,
      afterState,
      beforeVersion,
      afterVersion: updated.moderationVersion as number,
      moderatedAt: now,
      publicReasonCode: reason.publicReasonCode,
      publicMessage: reason.publicMessage,
    });
  }

  async enqueue(input: EnqueueAdminPostTransitionInput): Promise<void> {
    const { transition } = input;
    await this.outbox.enqueue({
      eventType: ADMIN_POST_MODERATION_EVENT_TYPE,
      dedupeKey:
        'post-moderation:' +
        transition.postPublicId +
        ':' +
        transition.afterVersion,
      aggregateType: ADMIN_POST_MODERATION_AGGREGATE_TYPE,
      aggregatePublicId: transition.postPublicId,
      payload: {
        schemaVersion: 1,
        postPublicId: transition.postPublicId,
        state: transition.afterState,
        publicReasonCode: transition.publicReasonCode,
        publicMessage: transition.publicMessage,
        moderationVersion: transition.afterVersion,
        cleanupRequested:
          input.operation === AdminPostModerationOperation.TERMINAL_DELETE,
      },
      correlationId: input.correlationId,
      mongoSession: input.mongoSession,
    });
  }

  private async load(
    input: AdminPostModerationTransitionInput,
    session: ClientSession,
  ): Promise<StoredPost | null> {
    const identity = input.postId
      ? { _id: input.postId }
      : { publicId: input.postPublicId };
    return this.posts
      .findOne(identity)
      .select(POST_PROJECTION)
      .session(session)
      .lean<StoredPost | null>()
      .exec();
  }

  private assertInput(input: AdminPostModerationTransitionInput): void {
    const validIdentity =
      input.postId instanceof Types.ObjectId !==
      Boolean(input.postPublicId && isValidPostPublicId(input.postPublicId));
    if (
      !validIdentity ||
      !Object.values(AdminPostModerationOperation).includes(input.operation) ||
      !Number.isSafeInteger(input.expectedModerationVersion) ||
      input.expectedModerationVersion < 0 ||
      !Object.values(CanonicalModerationReasonCode).includes(
        input.reasonCode,
      ) ||
      !input.actorPublicId
    ) {
      throw new BadRequestException('Post moderation input không hợp lệ');
    }
  }

  private assertTransition(
    post: StoredPost,
    input: AdminPostModerationTransitionInput,
    now: Date,
  ): void {
    if (
      (post.moderationVersion ?? 0) !== input.expectedModerationVersion ||
      post.expireAt.getTime() <= now.getTime()
    ) {
      throw this.staleConflict();
    }
    const state = this.state(post);
    if (
      input.operation === AdminPostModerationOperation.HIDE &&
      state !== PostModerationState.ACTIVE
    ) {
      throw new ConflictException('Chỉ Post active mới được ẩn');
    }
    if (
      input.operation === AdminPostModerationOperation.RESTORE &&
      state !== PostModerationState.HIDDEN
    ) {
      throw new ConflictException('Chỉ Post hidden mới được khôi phục');
    }
    if (
      input.operation === AdminPostModerationOperation.TERMINAL_DELETE &&
      state === PostModerationState.TERMINAL_DELETED
    ) {
      throw new ConflictException('Post đã terminal delete');
    }
  }

  private async assertRestorable(
    post: StoredPost,
    session: ClientSession,
    now: Date,
  ): Promise<void> {
    const author = await this.users
      .exists({ _id: post.authorId, ...buildEligibleUserMatch(now) })
      .session(session);
    if (!author) throw new ConflictException('Author không còn đủ điều kiện');
    const assetsExist = post.images.every(
      (image) =>
        typeof image.publicId === 'string' &&
        image.publicId.trim().length > 0 &&
        typeof image.url === 'string' &&
        image.url.trim().length > 0,
    );
    if (!assetsExist) {
      throw new ConflictException('Asset của Post không còn đầy đủ');
    }
  }

  private state(post: StoredPost): PostModerationState {
    if (
      post.moderationState === PostModerationState.TERMINAL_DELETED ||
      (post.isDeletedByAdmin &&
        post.moderationState !== PostModerationState.HIDDEN)
    ) {
      return PostModerationState.TERMINAL_DELETED;
    }
    return post.moderationState ?? PostModerationState.ACTIVE;
  }

  private afterState(
    operation: AdminPostModerationOperation,
  ): PostModerationState {
    if (operation === AdminPostModerationOperation.HIDE) {
      return PostModerationState.HIDDEN;
    }
    if (operation === AdminPostModerationOperation.RESTORE) {
      return PostModerationState.ACTIVE;
    }
    return PostModerationState.TERMINAL_DELETED;
  }

  private casFilter(
    post: StoredPost,
    input: AdminPostModerationTransitionInput,
    now: Date,
  ): Record<string, unknown> {
    const expectedVersion = input.expectedModerationVersion;
    const version =
      expectedVersion === 0
        ? {
            $or: [
              { moderationVersion: 0 },
              { moderationVersion: { $exists: false } },
            ],
          }
        : { moderationVersion: expectedVersion };
    const expectedState =
      input.operation === AdminPostModerationOperation.RESTORE
        ? { moderationState: PostModerationState.HIDDEN }
        : input.operation === AdminPostModerationOperation.HIDE
          ? {
              $or: [
                { moderationState: PostModerationState.ACTIVE },
                { moderationState: { $exists: false } },
              ],
            }
          : {
              moderationState: {
                $ne: PostModerationState.TERMINAL_DELETED,
              },
            };
    return {
      _id: post._id,
      publicId: post.publicId,
      expireAt: { $gt: now },
      $and: [version, expectedState],
    };
  }

  private transitionUpdate(
    input: AdminPostModerationTransitionInput,
    reasonCode: CanonicalModerationReasonCode,
    afterState: PostModerationState,
    now: Date,
  ): Record<string, unknown> {
    const terminal =
      input.operation === AdminPostModerationOperation.TERMINAL_DELETE;
    const restore = input.operation === AdminPostModerationOperation.RESTORE;
    const set: Record<string, unknown> = {
      moderationState: afterState,
      moderationReasonCode: reasonCode,
      moderatedByAdminPublicId: input.actorPublicId,
      moderatedAt: now,
      moderationTerminalAt: terminal ? now : null,
      isDeletedByAdmin: !restore,
    };
    if (terminal) {
      Object.assign(set, {
        cleanupStatus: PostCleanupStatus.PENDING,
        cleanupLockedUntil: null,
        cleanupAttempts: 0,
        cleanupLastError: null,
      });
    }
    return { $set: set, $inc: { moderationVersion: 1 } };
  }

  private staleConflict(): ConflictException {
    return new ConflictException(
      'Post đã thay đổi, hết hạn hoặc cleanup đã bắt đầu',
    );
  }
}
