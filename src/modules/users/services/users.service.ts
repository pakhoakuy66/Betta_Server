import {
  HttpException,
  ServiceUnavailableException,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  Connection,
  Model,
  Types,
  type ClientSession,
  type PipelineStage,
} from 'mongoose';
import * as bcrypt from 'bcrypt';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  DEFAULT_NOTIFICATION_SETTINGS,
  User,
  type NotificationSettings,
} from '../schemas/user.schema';
import {
  SearchUsersQueryDto,
  SuggestUsersQueryDto,
  UpdateNotificationSettingsDto,
  UpdateProfileDto,
} from '../dto/users.dto';
import { AuthSessionService } from '../../auth/services/auth-session.service';
import { AuthAuditService } from '../../auth/services/auth-audit.service';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../../auth/interfaces/auth-audit.interface';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { SessionRevokeReason } from '../../auth/schemas/auth-session.schema';
import { UserProfileResponse } from '../interfaces/users.interface';
import { UploadsService } from '../../uploads/services/uploads.service';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Post } from '../../posts/schemas/post.schema';
import { Reaction } from '../../reactions/schemas/reaction.schema';
import { PostShare } from '../../posts/schemas/post-share.schema';
import { Notification } from '../../notifications/schemas/notifications.schema';
import { EngagementEvent } from '../../recap/schemas/engagement-event.schema';
import { WeeklyRecap } from '../../recap/schemas/recap.schema';
import { StreakHistory } from '../../streak/schemas/streak.schema';
import { ReportCooldown } from '../../reports/schemas/report-cooldown.schema';
import { UserDeletionOrigin } from '../constants/user-moderation.constants';
import {
  buildEligibleUserMatch,
  withEligibleUserMatch,
} from '../policies/user-eligibility.policy';

const DELETE_ACCOUNT_TRANSACTION_MAX_RETRIES = 3;
const TRANSIENT_TRANSACTION_ERROR_LABEL = 'TransientTransactionError';

type MongoErrorWithLabels = {
  errorLabels?: string[];
  hasErrorLabel?: (label: string) => boolean;
};

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type CountResult = {
  total: number;
};

type SuggestedUserResult = {
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
  bio: string;
  streakCount: number;
  followersCount: number;
};

type PublicProfileUser = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
  avatarId: string;
  bio?: string;
  link?: string;
  streakCount?: number;
  postsCount?: number;
};

type CurrentUserResponseSource = {
  publicId: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar?: string | null;
  avatarId?: string | null;
  bio?: string | null;
  link?: string | null;
  streakCount?: number;
  postsCount?: number;
  followersCount?: number;
  followingCount?: number;
  status?: string;
  notificationSettings?: Partial<NotificationSettings> | null;
};

type SuggestedUserResponse = {
  id: string;
  publicId: string;
  username: string;
  fullname: string;
  avatar: string;
  bio: string;
  streakCount: number;
  followersCount: number;
};

type SuggestUsersResponse = {
  success: true;
  data: SuggestedUserResponse[];
  meta: {
    limit: number;
    count: number;
  };
};

type AccountCleanupAssets = {
  avatarPublicId: string | null;
  postImagePublicIds: string[];
};

type UserPostAsset = {
  _id: Types.ObjectId;
  images?: {
    publicId?: string;
  }[];
};

type UserReactionPost = {
  postId: Types.ObjectId;
};

type UserWeeklyRecap = {
  _id: Types.ObjectId;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(Reaction.name)
    private readonly reactionModel: Model<Reaction>,
    @InjectModel(PostShare.name)
    private readonly postShareModel: Model<PostShare>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    @InjectModel(EngagementEvent.name)
    private readonly engagementEventModel: Model<EngagementEvent>,
    @InjectModel(WeeklyRecap.name)
    private readonly weeklyRecapModel: Model<WeeklyRecap>,
    @InjectModel(StreakHistory.name)
    private readonly streakHistoryModel: Model<StreakHistory>,
    @InjectModel(ReportCooldown.name)
    private readonly reportCooldownModel: Model<ReportCooldown>,
    private readonly uploadsService: UploadsService,
    private readonly authSessionService: AuthSessionService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  private isMongoErrorWithLabels(
    error: unknown,
  ): error is MongoErrorWithLabels {
    return typeof error === 'object' && error !== null;
  }

  private isTransientTransactionError(error: unknown): boolean {
    if (!this.isMongoErrorWithLabels(error)) return false;

    if (typeof error.hasErrorLabel === 'function') {
      return error.hasErrorLabel(TRANSIENT_TRANSACTION_ERROR_LABEL);
    }

    return (
      Array.isArray(error.errorLabels) &&
      error.errorLabels.includes(TRANSIENT_TRANSACTION_ERROR_LABEL)
    );
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async runInTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= DELETE_ACCOUNT_TRANSACTION_MAX_RETRIES;
      attempt += 1
    ) {
      const session = await this.connection.startSession();

      try {
        const result = await session.withTransaction(() => operation(session));
        return result as T;
      } catch (error) {
        lastError = error;

        const shouldRetry =
          this.isTransientTransactionError(error) &&
          attempt < DELETE_ACCOUNT_TRANSACTION_MAX_RETRIES;

        if (!shouldRetry) {
          if (error instanceof HttpException) {
            throw error;
          }

          if (isMongoInfrastructureError(error)) {
            throw new ServiceUnavailableException(
              'Không thể hoàn tất thao tác bảo mật',
            );
          }

          throw error;
        }

        this.logger.warn(
          `Retrying delete account transaction. attempt=${attempt}, error=${this.getErrorMessage(error)}`,
        );
      } finally {
        await session.endSession();
      }
    }

    throw lastError;
  }

  // Search
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async getHiddenUserIdsForSearch(currentUserId: string) {
    const currentObjectId = new Types.ObjectId(currentUserId);

    const blocks = await this.blockModel
      .find({
        $or: [{ blockerId: currentObjectId }, { blockedId: currentObjectId }],
      })
      .select('blockerId blockedId')
      .lean()
      .exec();

    const blockedUserIds = blocks.map((block) => {
      const blockerId = block.blockerId.toString();

      return blockerId === currentObjectId.toString()
        ? block.blockedId
        : block.blockerId;
    });

    return [currentObjectId, ...blockedUserIds];
  }

  async searchUsers(currentUserId: string, query: SearchUsersQueryDto) {
    const now = new Date();
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const keyword = query.q.trim();
    const escapedKeyword = this.escapeRegExp(keyword);
    const hiddenUserIds = await this.getHiddenUserIdsForSearch(currentUserId);

    const filter = withEligibleUserMatch(
      {
        username: {
          $regex: escapedKeyword,
          $options: 'i',
        },
        _id: {
          $nin: hiddenUserIds,
        },
      },
      now,
    );

    const users = await this.userModel
      .find(filter)
      .select('publicId username fullname avatar bio streakCount')
      .sort({ username: 1, _id: 1 })
      .collation({ locale: 'en', strength: 2 })
      .skip(skip)
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = users.length > limit;
    const items = hasMore ? users.slice(0, limit) : users;

    return {
      success: true,
      data: items.map((user) => ({
        id: user.publicId,
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
        streakCount: user.streakCount,
      })),
      pagination: {
        page,
        limit,
        hasMore,
      },
    };
  }

  async suggestUsers(
    currentUserId: string,
    query: SuggestUsersQueryDto,
  ): Promise<SuggestUsersResponse> {
    if (!Types.ObjectId.isValid(currentUserId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }

    const currentObjectId = new Types.ObjectId(currentUserId);
    const now = new Date();
    const limit = query.limit ?? 10;
    const excludePublicIds = query.excludePublicIds ?? [];

    const currentUser = await this.userModel
      .findOne(
        withEligibleUserMatch(
          {
            _id: currentObjectId,
          },
          now,
        ),
      )
      .select('_id')
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    const excludedObjectIds =
      await this.getExcludedUserObjectIdsForSuggestions(currentObjectId);

    const matchStage: PipelineStage.Match['$match'] = {
      _id: { $nin: excludedObjectIds },
      ...buildEligibleUserMatch(now),
    };

    if (excludePublicIds.length > 0) {
      matchStage.publicId = { $nin: excludePublicIds };
    }

    const pipeline: PipelineStage[] = [
      { $match: matchStage },
      { $sample: { size: limit } },
      {
        $project: {
          _id: 0,
          publicId: 1,
          username: 1,
          fullname: 1,
          avatar: 1,
          bio: 1,
          streakCount: 1,
          followersCount: 1,
        },
      },
    ];

    const users = await this.userModel
      .aggregate<SuggestedUserResult>(pipeline)
      .exec();

    return {
      success: true,
      data: users.map((user) => ({
        id: user.publicId,
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
        streakCount: user.streakCount,
        followersCount: user.followersCount,
      })),
      meta: {
        limit,
        count: users.length,
      },
    };
  }

  // Lấy Profile theo Username (Dành cho việc người khác vào xem tường nhà)
  async getProfileByUsername(
    username: string,
    currentUserId?: string,
  ): Promise<{ success: boolean; data: UserProfileResponse }> {
    const now = new Date();
    const user = await this.userModel
      .findOne(
        withEligibleUserMatch(
          {
            username,
          },
          now,
        ),
      )
      .select(
        '_id publicId username fullname avatar avatarId bio link streakCount postsCount',
      )
      .lean<PublicProfileUser>()
      .exec();

    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng này');
    }

    let isFollowing = false;

    if (currentUserId) {
      if (!Types.ObjectId.isValid(currentUserId)) {
        throw new NotFoundException('Không tìm thấy người dùng này');
      }

      const currentId = new Types.ObjectId(currentUserId);
      const targetId = user._id;

      const blockRecord = await this.blockModel
        .findOne({
          $or: [
            { blockerId: currentId, blockedId: targetId },
            { blockerId: targetId, blockedId: currentId },
          ],
        })
        .select('_id')
        .lean()
        .exec();

      if (blockRecord) {
        throw new NotFoundException('Không tìm thấy người dùng này');
      }

      const followRecord = await this.relationshipModel
        .findOne({
          followerId: currentId,
          followingId: targetId,
        })
        .select('_id')
        .lean()
        .exec();

      isFollowing = Boolean(followRecord);
    }

    const [realFollowersCount, realFollowingCount] = await Promise.all([
      this.countEligibleFollowers(user._id, now),
      this.countEligibleFollowing(user._id, now),
    ]);

    return {
      success: true,
      data: {
        id: user.publicId,
        publicId: user.publicId,
        username: user.username,
        fullname: user.fullname,
        avatar: user.avatar,
        hasCustomAvatar: user.avatarId !== DEFAULT_AVATAR_ID,
        bio: user.bio ?? '',
        link: user.link ?? '',
        streakCount: user.streakCount ?? 0,
        postsCount: user.postsCount ?? 0,
        followersCount: realFollowersCount,
        followingCount: realFollowingCount,
        isFollowing,
        isBlocked: false,
      },
    };
  }

  private toCurrentUserResponse(user: CurrentUserResponseSource) {
    return {
      id: user.publicId,
      publicId: user.publicId,
      username: user.username,
      fullname: user.fullname,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar ?? null,
      hasCustomAvatar: user.avatarId !== DEFAULT_AVATAR_ID,
      bio: user.bio ?? '',
      link: user.link ?? '',
      streakCount: user.streakCount ?? 0,
      postsCount: user.postsCount ?? 0,
      followersCount: user.followersCount ?? 0,
      followingCount: user.followingCount ?? 0,
      status: user.status ?? 'active',
      notificationSettings: this.normalizeNotificationSettings(
        user.notificationSettings,
      ),
    };
  }

  private buildUpdateProfilePayload(updateData: UpdateProfileDto) {
    const payload: Partial<Pick<User, 'username' | 'bio' | 'link'>> = {};

    if (updateData.username !== undefined) {
      payload.username = updateData.username;
    }

    if (updateData.bio !== undefined) {
      payload.bio = updateData.bio;
    }

    if (updateData.link !== undefined) {
      payload.link = updateData.link;
    }

    return payload;
  }

  // Cập nhật thông tin cá nhân (Dành cho chính chủ)
  async updateProfile(userId: string, updateData: UpdateProfileDto) {
    const allowedUpdates = this.buildUpdateProfilePayload(updateData);

    if (Object.keys(allowedUpdates).length === 0) {
      throw new BadRequestException('Không có dữ liệu hợp lệ để cập nhật');
    }

    const userObjectId = new Types.ObjectId(userId);

    if (allowedUpdates.username !== undefined) {
      const duplicateUsername = await this.userModel
        .findOne({
          _id: { $ne: userObjectId },
          username: allowedUpdates.username,
          isDeleted: false,
        })
        .select('_id')
        .lean()
        .exec();

      if (duplicateUsername) {
        throw new ConflictException('Username đã được sử dụng');
      }
    }

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        { $set: allowedUpdates },
        { new: true, runValidators: true },
      )
      .select(
        '-password -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!updatedUser) {
      throw new BadRequestException('Không thể cập nhật hồ sơ');
    }

    return {
      success: true,
      message: 'Cập nhật thông tin thành công',
      data: this.toCurrentUserResponse(updatedUser),
    };
  }

  async updateAvatar(userId: string, file?: UploadFile) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn ảnh avatar');
    }

    const userObjectId = new Types.ObjectId(userId);

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select('_id avatarId')
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Không tìm thấy tài khoản hợp lệ');
    }

    const uploadedAvatar = await this.uploadsService.uploadAvatar(file);

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            avatar: uploadedAvatar.url,
            avatarId: uploadedAvatar.publicId,
          },
        },
        { new: true, runValidators: true },
      )
      .select(
        '-password -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec()
      .catch(async (error: unknown) => {
        await this.uploadsService.deleteImage(uploadedAvatar.publicId);
        throw error;
      });

    if (!updatedUser) {
      await this.uploadsService.deleteImage(uploadedAvatar.publicId);
      throw new BadRequestException('Không thể cập nhật avatar');
    }

    const oldAvatarId = currentUser.avatarId;

    if (oldAvatarId && oldAvatarId !== DEFAULT_AVATAR_ID) {
      // MongoDB đã commit; cleanup cũ không được giữ response của người dùng.
      void this.uploadsService.deleteImage(oldAvatarId);
    }

    return {
      success: true,
      message: 'Cập nhật thông tin thành công',
      data: this.toCurrentUserResponse(updatedUser),
    };
  }

  async removeAvatar(userId: string) {
    const userObjectId = new Types.ObjectId(userId);

    const currentUser = await this.userModel
      .findOne({
        _id: userObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select(
        '-password -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!currentUser) {
      throw new NotFoundException('Không tìm thấy tài khoản hợp lệ');
    }

    if (currentUser.avatarId === DEFAULT_AVATAR_ID) {
      return {
        success: true,
        message: 'Avatar đang là ảnh mặc định',
        data: this.toCurrentUserResponse(currentUser),
      };
    }

    const oldAvatarId = currentUser.avatarId;

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userObjectId,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            avatar: DEFAULT_AVATAR_URL,
            avatarId: DEFAULT_AVATAR_ID,
          },
        },
        { new: true, runValidators: true },
      )
      .select(
        '-password -forgotPasswordOtp -forgotPasswordExpiry -isDeleted -deletedAt',
      )
      .lean()
      .exec();

    if (!updatedUser) {
      throw new BadRequestException('Không thể xóa avatar');
    }

    if (oldAvatarId) {
      try {
        await this.uploadsService.deleteImage(oldAvatarId);
      } catch (cleanupError: unknown) {
        this.logger.warn(
          `[AVATAR_CLEANUP_FAILED] Failed to delete avatar ${oldAvatarId}: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }

    return {
      success: true,
      message: 'Đã xóa avatar',
      data: this.toCurrentUserResponse(updatedUser),
    };
  }

  private normalizeNotificationSettings(
    settings?: Partial<NotificationSettings> | null,
  ): NotificationSettings {
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...(settings ?? {}),
    };
  }

  async getMyNotificationSettings(userId: string) {
    const user = await this.userModel
      .findOne({
        _id: userId,
        isDeleted: false,
        status: 'active',
      })
      .select('notificationSettings')
      .lean<{ notificationSettings?: Partial<NotificationSettings> }>()
      .exec();

    if (!user) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    return {
      success: true,
      data: this.normalizeNotificationSettings(user.notificationSettings),
    };
  }

  async updateMyNotificationSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ) {
    const updateFields: Record<string, boolean> = {};

    (['enabled', 'follow', 'reaction', 'recap'] as const).forEach((key) => {
      if (typeof dto[key] === 'boolean') {
        updateFields[`notificationSettings.${key}`] = dto[key];
      }
    });

    if (Object.keys(updateFields).length === 0) {
      throw new BadRequestException(
        'Không có cài đặt thông báo nào để cập nhật',
      );
    }

    const user = await this.userModel
      .findOneAndUpdate(
        {
          _id: userId,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: updateFields,
        },
        {
          new: true,
          projection: {
            notificationSettings: 1,
          },
        },
      )
      .lean<{ notificationSettings?: Partial<NotificationSettings> }>()
      .exec();

    if (!user) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    return {
      success: true,
      message: 'Đã cập nhật cài đặt thông báo',
      data: this.normalizeNotificationSettings(user.notificationSettings),
    };
  }

  // Trong UsersService (Chuyển đổi trạng thái thay vì xóa hẳn)
  async softDeleteUser(userId: string, currentPassword: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const uid = new Types.ObjectId(userId);

    const user = await this.userModel
      .findOne({
        _id: uid,
        isDeleted: false,
        status: 'active',
      })
      .select('+password')
      .exec();

    if (!user) {
      throw new NotFoundException(
        'Không tìm thấy người dùng hoặc tài khoản đã bị xóa trước đó',
      );
    }

    if (!user.password) {
      throw new BadRequestException(
        'Tài khoản này chưa có mật khẩu để xác nhận thao tác xóa',
      );
    }

    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Mật khẩu không chính xác');
    }

    const cleanupAssets: AccountCleanupAssets = {
      avatarPublicId:
        user.avatarId && user.avatarId !== DEFAULT_AVATAR_ID
          ? user.avatarId
          : null,
      postImagePublicIds: [],
    };

    await this.runInTransaction(async (session) => {
      const now = new Date();

      const userPosts = await this.postModel
        .find({ authorId: uid })
        .select('_id images')
        .session(session)
        .lean<UserPostAsset[]>()
        .exec();

      const postIds = userPosts.map((post) => post._id);

      cleanupAssets.postImagePublicIds =
        this.collectPostImagePublicIds(userPosts);

      const userReactionPosts = await this.reactionModel
        .find({
          userId: uid,
          ...(postIds.length > 0 ? { postId: { $nin: postIds } } : {}),
        })
        .select('postId')
        .session(session)
        .lean<UserReactionPost[]>()
        .exec();

      const reactedPostIds = [
        ...new Set(
          userReactionPosts.map((reaction) => reaction.postId.toString()),
        ),
      ].map((postId) => new Types.ObjectId(postId));

      const userWeeklyRecaps = await this.weeklyRecapModel
        .find({ userId: uid })
        .select('_id')
        .session(session)
        .lean<UserWeeklyRecap[]>()
        .exec();

      const userWeeklyRecapIds = userWeeklyRecaps.map((recap) => recap._id);

      const claimResult = await this.userModel
        .updateOne(
          {
            _id: uid,
            isDeleted: false,
            status: 'active',
          },
          {
            $set: {
              isDeleted: true,
              deletedAt: now,
              deletionOrigin: UserDeletionOrigin.USER_SELF_DELETED,
              restorableUntil: null,
              followersCount: 0,
              followingCount: 0,
              postsCount: 0,
              avatarId: DEFAULT_AVATAR_ID,
              avatar: DEFAULT_AVATAR_URL,
              bio: '',
              link: '',
            },
            $inc: {
              version: 1,
              authzVersion: 1,
            },
            $unset: {
              forgotPasswordOtp: '',
              forgotPasswordExpiry: '',
              forgotPasswordAttempts: '',
              failedLoginAttempts: '',
              failedLoginWindowStartedAt: '',
              lockedUntil: '',
            },
          },
          { session },
        )
        .exec();

      if (claimResult.matchedCount !== 1) {
        throw new NotFoundException(
          'Không tìm thấy người dùng hoặc tài khoản đã bị xóa trước đó',
        );
      }

      const affectedSessionCount =
        await this.authSessionService.revokeAllSessions(
          uid,
          SessionRevokeReason.ACCOUNT_DELETED,
          session,
        );

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.ACCOUNT_DELETED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.ACCOUNT_DELETION_COMPLETED,
        targetUserId: uid,
        actorUserId: uid,
        metadata: {
          affectedSessionCount,
        },
        mongoSession: session,
      });

      const followings = await this.relationshipModel
        .find({ followerId: uid })
        .select('followingId')
        .session(session)
        .lean()
        .exec();

      const followers = await this.relationshipModel
        .find({ followingId: uid })
        .select('followerId')
        .session(session)
        .lean()
        .exec();

      const followingIds = followings.map((rel) => rel.followingId);
      const followerIds = followers.map((rel) => rel.followerId);

      await this.relationshipModel
        .deleteMany({
          $or: [{ followerId: uid }, { followingId: uid }],
        })
        .session(session)
        .exec();

      await this.blockModel
        .deleteMany({
          $or: [{ blockerId: uid }, { blockedId: uid }],
        })
        .session(session)
        .exec();

      await this.postModel
        .deleteMany({ authorId: uid })
        .session(session)
        .exec();

      await this.reactionModel
        .deleteMany({
          $or: [
            { userId: uid },
            { postOwnerId: uid },
            ...(postIds.length > 0 ? [{ postId: { $in: postIds } }] : []),
          ],
        })
        .session(session)
        .exec();

      if (reactedPostIds.length > 0) {
        await this.postModel
          .updateMany(
            {
              _id: { $in: reactedPostIds },
              likeCount: { $gt: 0 },
            },
            { $inc: { likeCount: -1 } },
          )
          .session(session)
          .exec();
      }

      await this.postShareModel
        .deleteMany({
          $or: [
            { userId: uid },
            ...(postIds.length > 0 ? [{ postId: { $in: postIds } }] : []),
          ],
        })
        .session(session)
        .exec();

      await this.notificationModel
        .deleteMany({
          $or: [
            { recipientId: uid },
            { actorIds: uid },
            { countedActorIds: uid },
            ...(postIds.length > 0 ? [{ targetId: { $in: postIds } }] : []),
            ...(userWeeklyRecapIds.length > 0
              ? [{ targetId: { $in: userWeeklyRecapIds } }]
              : []),
          ],
        })
        .session(session)
        .exec();

      await this.engagementEventModel
        .deleteMany({
          $or: [
            { actorId: uid },
            { postOwnerId: uid },
            ...(postIds.length > 0 ? [{ postId: { $in: postIds } }] : []),
          ],
        })
        .session(session)
        .exec();

      await this.weeklyRecapModel
        .deleteMany({ userId: uid })
        .session(session)
        .exec();

      await this.weeklyRecapModel
        .updateMany(
          {
            $or: [{ 'stats.topGivers': uid }, { 'stats.topReceivers': uid }],
          },
          {
            $pull: {
              'stats.topGivers': uid,
              'stats.topReceivers': uid,
            },
          },
        )
        .session(session)
        .exec();

      await this.streakHistoryModel
        .deleteMany({ userId: uid })
        .session(session)
        .exec();

      await this.reportCooldownModel
        .deleteMany({
          $or: [
            { reporterId: uid },
            { targetId: uid },
            ...(postIds.length > 0 ? [{ targetId: { $in: postIds } }] : []),
          ],
        })
        .session(session)
        .exec();

      if (followingIds.length > 0) {
        await this.userModel
          .updateMany(
            {
              _id: { $in: followingIds },
              followersCount: { $gt: 0 },
            },
            { $inc: { followersCount: -1 } },
          )
          .session(session)
          .exec();
      }

      if (followerIds.length > 0) {
        await this.userModel
          .updateMany(
            {
              _id: { $in: followerIds },
              followingCount: { $gt: 0 },
            },
            { $inc: { followingCount: -1 } },
          )
          .session(session)
          .exec();
      }
    });

    void this.cleanupDeletedAccountAssets(cleanupAssets);

    return {
      success: true,
      message: 'Đã xóa tài khoản thành công',
    };
  }

  private async countEligibleFollowers(
    userId: Types.ObjectId,
    now: Date,
  ): Promise<number> {
    const result = await this.relationshipModel.aggregate<CountResult>([
      { $match: { followingId: userId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followerId',
          foreignField: '_id',
          as: 'follower',
        },
      },
      { $unwind: '$follower' },
      { $match: buildEligibleUserMatch(now, 'follower') },
      { $count: 'total' },
    ]);

    return result[0]?.total ?? 0;
  }

  private async countEligibleFollowing(
    userId: Types.ObjectId,
    now: Date,
  ): Promise<number> {
    const result = await this.relationshipModel.aggregate<CountResult>([
      { $match: { followerId: userId } },
      {
        $lookup: {
          from: 'users',
          localField: 'followingId',
          foreignField: '_id',
          as: 'following',
        },
      },
      { $unwind: '$following' },
      { $match: buildEligibleUserMatch(now, 'following') },
      { $count: 'total' },
    ]);

    return result[0]?.total ?? 0;
  }

  private async getExcludedUserObjectIdsForSuggestions(
    currentObjectId: Types.ObjectId,
  ): Promise<Types.ObjectId[]> {
    const [relationships, blocks] = await Promise.all([
      this.relationshipModel
        .find({ followerId: currentObjectId })
        .select('followingId')
        .lean()
        .exec(),

      this.blockModel
        .find({
          $or: [{ blockerId: currentObjectId }, { blockedId: currentObjectId }],
        })
        .select('blockerId blockedId')
        .lean()
        .exec(),
    ]);

    const currentUserId = currentObjectId.toString();
    const excludedIds = new Set<string>([currentUserId]);

    relationships.forEach((relationship) => {
      excludedIds.add(relationship.followingId.toString());
    });

    blocks.forEach((block) => {
      const blockerId = block.blockerId.toString();
      const blockedId = block.blockedId.toString();

      excludedIds.add(blockerId === currentUserId ? blockedId : blockerId);
    });

    return [...excludedIds].map((id) => new Types.ObjectId(id));
  }

  // Cleanup assets
  private collectPostImagePublicIds(posts: UserPostAsset[]): string[] {
    return [
      ...new Set(
        posts.flatMap((post) =>
          (post.images ?? [])
            .map((image) => image.publicId)
            .filter(
              (publicId): publicId is string =>
                typeof publicId === 'string' && publicId.trim().length > 0,
            ),
        ),
      ),
    ];
  }

  private async cleanupDeletedAccountAssets(
    assets: AccountCleanupAssets,
  ): Promise<void> {
    const publicIds = [...assets.postImagePublicIds];

    if (assets.avatarPublicId && assets.avatarPublicId !== DEFAULT_AVATAR_ID) {
      publicIds.push(assets.avatarPublicId);
    }

    if (publicIds.length === 0) return;

    try {
      await this.uploadsService.deleteImages(publicIds);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to cleanup deleted account assets: ${this.getErrorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
