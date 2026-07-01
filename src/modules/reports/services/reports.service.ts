import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  Connection,
  Model,
  Types,
  type ClientSession,
  type UpdateWriteOpResult,
} from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import {
  Report,
  ReportReasonGroup,
  ReportTargetType,
} from '../schemas/report.schema';
import { ReportPostDto } from '../dto/report-post.dto';
import { ReportUserDto } from '../dto/report-user.dto';
import { Post } from '../../posts/schemas/post.schema';
import { User } from '../../users/schemas/user.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { ReportCooldown } from '../schemas/report-cooldown.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';

const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const REPORT_RATE_LIMIT_MAX = 10;
const POST_REPORT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const USER_REPORT_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;
const TRANSACTION_MAX_RETRIES = 3;
const USER_PUBLIC_ID_PATTERN =
  /^usr_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{10}$/;

type MongoDuplicateKeyError = {
  code?: number;
};

type MongoTransactionError = {
  errorLabels?: string[];
  hasErrorLabel?: (label: string) => boolean;
};

type ReportablePost = {
  _id: Types.ObjectId;
  publicId: string;
  authorId: Types.ObjectId;
  content: string;
  images: { url: string; publicId: string }[];
  createdAt?: Date;
  expireAt?: Date;
};

type ReportAuthor = {
  _id: Types.ObjectId;
  username: string;
};

type ReportableUser = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname?: string | null;
  avatar?: string | null;
  bio?: string | null;
  status?: string | null;
};

@Injectable()
export class ReportsService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(Report.name)
    private readonly reportModel: Model<Report>,

    @InjectModel(ReportCooldown.name)
    private readonly reportCooldownModel: Model<ReportCooldown>,

    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    @InjectModel(Relationship.name)
    private readonly relationshipModel: Model<Relationship>,

    @InjectModel(Block.name)
    private readonly blockModel: Model<Block>,
  ) {}

  async reportPost(userId: string, publicId: string, dto: ReportPostDto) {
    const reporterObjectId = this.toObjectId(userId);

    if (!isValidPostPublicId(publicId)) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    await this.assertReportRateLimit(reporterObjectId);

    const now = new Date();

    const [reporter, post] = await Promise.all([
      this.userModel
        .findOne({
          _id: reporterObjectId,
          isDeleted: false,
          status: 'active',
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
        .select('_id publicId authorId content images createdAt expireAt')
        .lean<ReportablePost>()
        .exec(),
    ]);

    if (!reporter) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    if (!post) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

    if (post.authorId.equals(reporterObjectId)) {
      throw new BadRequestException(
        'Bạn không thể báo cáo bài viết của chính mình',
      );
    }

    const [author, blockRecord, relationship] = await Promise.all([
      this.userModel
        .findOne({
          _id: post.authorId,
          isDeleted: false,
          status: 'active',
        })
        .select('_id username')
        .lean<ReportAuthor>()
        .exec(),

      this.blockModel
        .findOne({
          $or: [
            { blockerId: reporterObjectId, blockedId: post.authorId },
            { blockerId: post.authorId, blockedId: reporterObjectId },
          ],
        })
        .select('_id')
        .lean()
        .exec(),

      this.relationshipModel
        .findOne({
          followerId: reporterObjectId,
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
        'Bạn cần theo dõi người dùng này để báo cáo bài viết',
      );
    }

    await this.runInTransaction(async (session) => {
      const report = await this.createPostReportWithCooldown({
        session,
        reporterId: reporterObjectId,
        post,
        author,
        dto,
      });

      await this.attachReportToCooldown({
        session,
        reporterId: reporterObjectId,
        targetType: ReportTargetType.POST,
        targetId: post._id,
        reportId: report._id,
      });
    });

    return {
      success: true,
      message: 'Đã gửi báo cáo bài viết',
    };
  }

  async reportUser(userId: string, publicId: string, dto: ReportUserDto) {
    const reporterObjectId = this.toObjectId(userId);

    if (!this.isValidUserPublicId(publicId)) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    const [reporter, targetUser] = await Promise.all([
      this.userModel
        .findOne({
          _id: reporterObjectId,
          isDeleted: false,
          status: 'active',
        })
        .select('_id')
        .lean()
        .exec(),

      this.userModel
        .findOne({
          publicId,
          isDeleted: false,
          status: 'active',
        })
        .select('_id publicId username fullname avatar bio status')
        .lean<ReportableUser>()
        .exec(),
    ]);

    if (!reporter) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    if (!targetUser) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    await this.assertReportRateLimit(reporterObjectId);

    if (targetUser._id.equals(reporterObjectId)) {
      throw new BadRequestException(
        'Bạn không thể báo cáo tài khoản của chính mình',
      );
    }

    const blockRecord = await this.blockModel
      .findOne({
        $or: [
          { blockerId: reporterObjectId, blockedId: targetUser._id },
          { blockerId: targetUser._id, blockedId: reporterObjectId },
        ],
      })
      .select('_id')
      .lean()
      .exec();

    if (blockRecord) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    await this.runInTransaction(async (session) => {
      const report = await this.createUserReportWithCooldown({
        session,
        reporterId: reporterObjectId,
        targetUser,
        dto,
      });

      await this.attachReportToCooldown({
        session,
        reporterId: reporterObjectId,
        targetType: ReportTargetType.USER,
        targetId: targetUser._id,
        reportId: report._id,
      });
    });

    return {
      success: true,
      message: 'Đã gửi báo cáo tài khoản',
    };
  }

  private async assertReportRateLimit(
    reporterId: Types.ObjectId,
  ): Promise<void> {
    const windowStart = new Date(Date.now() - REPORT_RATE_LIMIT_WINDOW_MS);

    const reportCount = await this.reportModel
      .countDocuments({
        reporterId,
        createdAt: { $gte: windowStart },
      })
      .exec();

    if (reportCount >= REPORT_RATE_LIMIT_MAX) {
      throw new HttpException(
        'Bạn đã gửi quá nhiều báo cáo. Vui lòng thử lại sau.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private isValidUserPublicId(publicId: string): boolean {
    return USER_PUBLIC_ID_PATTERN.test(publicId);
  }

  private buildImageSnapshot(
    images: { url: string; publicId: string }[] = [],
  ): { url: string; publicId: string }[] {
    return images.map((image) => ({
      url: image.url,
      publicId: image.publicId,
    }));
  }

  private toObjectId(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    return new Types.ObjectId(id);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }

  private isTransientTransactionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;

    const mongoError = error as MongoTransactionError;

    if (mongoError.hasErrorLabel?.('TransientTransactionError')) {
      return true;
    }

    return Boolean(
      mongoError.errorLabels?.includes('TransientTransactionError'),
    );
  }

  private async runInTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TRANSACTION_MAX_RETRIES; attempt += 1) {
      const session = await this.connection.startSession();

      session.startTransaction();

      try {
        const result = await operation(session);

        await session.commitTransaction();

        return result;
      } catch (error) {
        lastError = error;

        if (session.inTransaction()) {
          await session.abortTransaction();
        }

        if (
          attempt < TRANSACTION_MAX_RETRIES &&
          this.isTransientTransactionError(error)
        ) {
          continue;
        }

        throw error;
      } finally {
        await session.endSession();
      }
    }

    throw lastError;
  }

  private async createPostReportWithCooldown({
    session,
    reporterId,
    post,
    author,
    dto,
  }: {
    session: ClientSession;
    reporterId: Types.ObjectId;
    post: ReportablePost;
    author: ReportAuthor;
    dto: ReportPostDto;
  }): Promise<Report> {
    await this.acquireReportCooldown({
      session,
      reporterId,
      targetType: ReportTargetType.POST,
      targetId: post._id,
      cooldownMs: POST_REPORT_COOLDOWN_MS,
      conflictMessage:
        'Bạn đã báo cáo bài viết này gần đây. Vui lòng thử lại sau 2 tiếng.',
    });

    const [report] = await this.reportModel.create(
      [
        {
          reporterId,
          targetType: ReportTargetType.POST,
          targetId: post._id,
          reasonGroup: dto.reasonGroup ?? ReportReasonGroup.VIOLATION_CONTENT,
          reasonDetail: dto.reasonDetail,
          description: dto.description ?? '',
          targetSnapshot: {
            publicId: post.publicId,
            authorId: post.authorId,
            authorUsername: author.username,
            content: post.content,
            images: this.buildImageSnapshot(post.images),
            createdAt: post.createdAt ?? null,
            expireAt: post.expireAt ?? null,
          },
        },
      ],
      { session },
    );

    return report;
  }

  private async createUserReportWithCooldown({
    session,
    reporterId,
    targetUser,
    dto,
  }: {
    session: ClientSession;
    reporterId: Types.ObjectId;
    targetUser: ReportableUser;
    dto: ReportUserDto;
  }): Promise<Report> {
    await this.acquireReportCooldown({
      session,
      reporterId,
      targetType: ReportTargetType.USER,
      targetId: targetUser._id,
      cooldownMs: USER_REPORT_COOLDOWN_MS,
      conflictMessage:
        'Bạn đã báo cáo tài khoản này gần đây. Vui lòng thử lại sau 2 ngày.',
    });

    const [report] = await this.reportModel.create(
      [
        {
          reporterId,
          targetType: ReportTargetType.USER,
          targetId: targetUser._id,
          reasonGroup: dto.reasonGroup ?? ReportReasonGroup.IMPERSONATION,
          reasonDetail: dto.reasonDetail,
          description: dto.description ?? '',
          targetSnapshot: {
            publicId: targetUser.publicId,
            username: targetUser.username,
            fullname: targetUser.fullname ?? '',
            avatar: targetUser.avatar ?? '',
            bio: targetUser.bio ?? '',
            targetStatus: targetUser.status ?? '',
          },
        },
      ],
      { session },
    );

    return report;
  }

  private async acquireReportCooldown({
    session,
    reporterId,
    targetType,
    targetId,
    cooldownMs,
    conflictMessage,
  }: {
    session: ClientSession;
    reporterId: Types.ObjectId;
    targetType: ReportTargetType;
    targetId: Types.ObjectId;
    cooldownMs: number;
    conflictMessage: string;
  }): Promise<void> {
    const now = new Date();
    const nextAllowedAt = new Date(now.getTime() + cooldownMs);

    try {
      const cooldown = await this.reportCooldownModel
        .findOneAndUpdate(
          {
            reporterId,
            targetType,
            targetId,
            $or: [
              { nextAllowedAt: { $lte: now } },
              { nextAllowedAt: { $exists: false } },
            ],
          },
          {
            $set: {
              nextAllowedAt,
            },
            $setOnInsert: {
              reporterId,
              targetType,
              targetId,
            },
          },
          {
            session,
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
          },
        )
        .select('_id')
        .lean<{ _id: Types.ObjectId }>()
        .exec();

      if (!cooldown) {
        throw new ConflictException(conflictMessage);
      }
    } catch (error: unknown) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException(conflictMessage);
      }

      throw error;
    }
  }

  private async attachReportToCooldown({
    session,
    reporterId,
    targetType,
    targetId,
    reportId,
  }: {
    session: ClientSession;
    reporterId: Types.ObjectId;
    targetType: ReportTargetType;
    targetId: Types.ObjectId;
    reportId: Types.ObjectId;
  }): Promise<void> {
    const result: UpdateWriteOpResult = await this.reportCooldownModel
      .updateOne(
        {
          reporterId,
          targetType,
          targetId,
        },
        {
          $set: {
            lastReportId: reportId,
          },
        },
        { session },
      )
      .exec();

    if (result.matchedCount !== 1) {
      throw new InternalServerErrorException(
        'Không thể cập nhật trạng thái cooldown báo cáo',
      );
    }
  }
}
