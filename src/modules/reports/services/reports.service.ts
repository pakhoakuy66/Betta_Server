import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { InjectModel } from '@nestjs/mongoose';
import {
  Connection,
  Model,
  Types,
  type ClientSession,
  type HydratedDocument,
  type UpdateWriteOpResult,
} from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { ReportPostDto } from '../dto/report-post.dto';
import { ReportUserDto } from '../dto/report-user.dto';
import { ReportIssueDto } from '../dto/report-issue.dto';
import { Post } from '../../posts/schemas/post.schema';
import { User } from '../../users/schemas/user.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { ReportCooldown } from '../schemas/report-cooldown.schema';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../schemas/report.schema';

import {
  SystemReport,
  SystemReportStatus,
} from '../schemas/system-report.schema';
import { isValidPostPublicId } from '../../posts/utils/generate-post-public-id';
import { UploadsService } from '../../uploads/services/uploads.service';
import { ReportRateLimitService } from './report-rate-limit.service';

const POST_REPORT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const USER_REPORT_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;
const TRANSACTION_MAX_RETRIES = 3;
const USER_PUBLIC_ID_PATTERN =
  /^usr_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{10}$/;
const SYSTEM_REPORT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const POST_REPORT_COOLDOWN_MESSAGE =
  'Bạn đã báo cáo bài viết này gần đây. Vui lòng thử lại sau 2 tiếng.';
const USER_REPORT_COOLDOWN_MESSAGE =
  'Bạn đã báo cáo tài khoản này gần đây. Vui lòng thử lại sau 2 ngày.';

type ReportSubmissionType = 'issue' | 'post' | 'user';

type UserVisibleReportStatus =
  | 'pending'
  | 'reviewing'
  | 'resolved'
  | 'rejected';

const REPORT_STATUS_TO_PUBLIC = {
  [ReportStatus.PENDING]: 'pending',
  [ReportStatus.REVIEWING]: 'reviewing',
  [ReportStatus.RESOLVED]: 'resolved',
  [ReportStatus.REJECTED]: 'rejected',
} satisfies Record<ReportStatus, UserVisibleReportStatus>;

const SYSTEM_REPORT_STATUS_TO_PUBLIC = {
  [SystemReportStatus.PENDING]: 'pending',
  [SystemReportStatus.INVESTIGATING]: 'reviewing',
  [SystemReportStatus.FIXED]: 'resolved',
  // CLOSED nghĩa là issue bị đóng mà không fix/không hợp lệ/không xử lý.
  [SystemReportStatus.CLOSED]: 'rejected',
} satisfies Record<SystemReportStatus, UserVisibleReportStatus>;

type ReportSubmissionData = {
  type: ReportSubmissionType;
  status: UserVisibleReportStatus;
  submittedAt: string;
};

type ReportSubmissionResponse = {
  success: true;
  message: string;
  data: ReportSubmissionData;
};

type CreatedReportDocument = HydratedDocument<Report> & {
  _id: Types.ObjectId;
  status: ReportStatus;
  createdAt: Date;
};

type CreatedSystemReportDocument = HydratedDocument<SystemReport> & {
  status: SystemReportStatus;
  createdAt: Date;
};

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

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
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

    @InjectModel(SystemReport.name)
    private readonly systemReportModel: Model<SystemReport>,

    private readonly uploadsService: UploadsService,

    private readonly reportRateLimitService: ReportRateLimitService,
  ) {}

  async reportIssue(
    userId: string,
    dto: ReportIssueDto,
    files: UploadFile[] = [],
    clientIp?: string,
  ): Promise<ReportSubmissionResponse> {
    const reporterObjectId = this.toObjectId(userId);

    const reporter = await this.userModel
      .findOne({
        _id: reporterObjectId,
        isDeleted: false,
        status: 'active',
      })
      .select('_id')
      .lean()
      .exec();

    if (!reporter) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    const normalizedDescription = this.normalizeSystemReportDescription(
      dto.description,
    );
    const descriptionHash = this.buildSystemReportDescriptionHash(
      normalizedDescription,
    );
    const dedupeKey = this.buildSystemReportDedupeKey(
      reporterObjectId,
      descriptionHash,
    );

    await this.assertNoRecentDuplicateSystemReport(
      reporterObjectId,
      descriptionHash,
    );

    await this.reportRateLimitService.consumeSystemReport({
      reporterId: reporterObjectId,
      clientIp,
      descriptionHash,
    });

    const uploadedImages =
      await this.uploadsService.uploadSystemReportImages(files);

    let systemReport: CreatedSystemReportDocument;

    try {
      systemReport = (await this.systemReportModel.create({
        reporterId: reporterObjectId,
        description: normalizedDescription,
        descriptionHash,
        dedupeKey,
        evidenceImages: uploadedImages.map((image) => ({
          url: image.url,
          publicId: image.publicId,
        })),
      })) as CreatedSystemReportDocument;
    } catch (error) {
      try {
        await this.uploadsService.deleteImages(
          uploadedImages.map((image) => image.publicId),
        );
      } catch (cleanupError) {
        this.logger.error(
          `Failed to cleanup system report evidence after create failure: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
          cleanupError instanceof Error ? cleanupError.stack : undefined,
        );
      }

      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException(
          'Bạn đã gửi báo cáo sự cố này gần đây. Vui lòng thử lại sau.',
        );
      }

      throw error;
    }

    return {
      success: true,
      message: 'Đã gửi báo cáo sự cố',
      data: this.toReportSubmissionData('issue', systemReport),
    };
  }

  async reportPost(
    userId: string,
    publicId: string,
    dto: ReportPostDto,
    clientIp?: string,
  ): Promise<ReportSubmissionResponse> {
    const reporterObjectId = this.toObjectId(userId);

    if (!isValidPostPublicId(publicId)) {
      throw new NotFoundException('Bài viết không tồn tại hoặc đã hết hạn');
    }

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

    await this.assertReportCooldownAvailable({
      reporterId: reporterObjectId,
      targetType: ReportTargetType.POST,
      targetId: post._id,
      conflictMessage: POST_REPORT_COOLDOWN_MESSAGE,
    });

    await this.reportRateLimitService.consumeContentReport({
      reporterId: reporterObjectId,
      clientIp,
      targetType: ReportTargetType.POST,
      targetId: post._id,
    });

    const report = await this.runInTransaction(async (session) => {
      const createdReport = await this.createPostReportWithCooldown({
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
        reportId: createdReport._id,
      });

      return createdReport;
    });

    return {
      success: true,
      message: 'Đã gửi báo cáo bài viết',
      data: this.toReportSubmissionData('post', report),
    };
  }

  async reportUser(
    userId: string,
    publicId: string,
    dto: ReportUserDto,
    clientIp?: string,
  ): Promise<ReportSubmissionResponse> {
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

    await this.assertReportCooldownAvailable({
      reporterId: reporterObjectId,
      targetType: ReportTargetType.USER,
      targetId: targetUser._id,
      conflictMessage: USER_REPORT_COOLDOWN_MESSAGE,
    });

    await this.reportRateLimitService.consumeContentReport({
      reporterId: reporterObjectId,
      clientIp,
      targetType: ReportTargetType.USER,
      targetId: targetUser._id,
    });

    const report = await this.runInTransaction(async (session) => {
      const createdReport = await this.createUserReportWithCooldown({
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
        reportId: createdReport._id,
      });

      return createdReport;
    });

    return {
      success: true,
      message: 'Đã gửi báo cáo tài khoản',
      data: this.toReportSubmissionData('user', report),
    };
  }

  private toReportSubmissionData(
    type: 'post' | 'user',
    report: CreatedReportDocument,
  ): ReportSubmissionData;

  private toReportSubmissionData(
    type: 'issue',
    report: CreatedSystemReportDocument,
  ): ReportSubmissionData;

  private toReportSubmissionData(
    type: ReportSubmissionType,
    report: CreatedReportDocument | CreatedSystemReportDocument,
  ): ReportSubmissionData {
    return {
      type,
      status:
        type === 'issue'
          ? this.toUserVisibleSystemReportStatus(
              (report as CreatedSystemReportDocument).status,
            )
          : this.toUserVisibleReportStatus(
              (report as CreatedReportDocument).status,
            ),
      submittedAt: this.getSubmittedAt(report),
    };
  }

  private toUserVisibleReportStatus(
    status: ReportStatus,
  ): UserVisibleReportStatus {
    return REPORT_STATUS_TO_PUBLIC[status];
  }

  private toUserVisibleSystemReportStatus(
    status: SystemReportStatus,
  ): UserVisibleReportStatus {
    return SYSTEM_REPORT_STATUS_TO_PUBLIC[status];
  }

  private getSubmittedAt(document: { createdAt?: Date }): string {
    const { createdAt } = document;

    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new InternalServerErrorException(
        'Report document không có createdAt hợp lệ',
      );
    }

    return createdAt.toISOString();
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

  private normalizeSystemReportDescription(description: string): string {
    return description.trim().replace(/\s+/g, ' ');
  }

  private buildSystemReportDescriptionHash(description: string): string {
    return createHash('sha256').update(description).digest('hex');
  }

  private buildSystemReportDedupeKey(
    reporterId: Types.ObjectId,
    descriptionHash: string,
  ): string {
    const bucket = Math.floor(Date.now() / SYSTEM_REPORT_DUPLICATE_WINDOW_MS);

    return `system_issue:${reporterId.toString()}:${descriptionHash}:${bucket}`;
  }

  private async assertNoRecentDuplicateSystemReport(
    reporterId: Types.ObjectId,
    descriptionHash: string,
  ): Promise<void> {
    const duplicateWindowStart = new Date(
      Date.now() - SYSTEM_REPORT_DUPLICATE_WINDOW_MS,
    );

    const existingReport = await this.systemReportModel
      .findOne({
        reporterId,
        descriptionHash,
        createdAt: { $gte: duplicateWindowStart },
      })
      .select('_id')
      .lean()
      .exec();

    if (existingReport) {
      throw new ConflictException(
        'Bạn đã gửi báo cáo sự cố này gần đây. Vui lòng thử lại sau.',
      );
    }
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
  }): Promise<CreatedReportDocument> {
    await this.acquireReportCooldown({
      session,
      reporterId,
      targetType: ReportTargetType.POST,
      targetId: post._id,
      cooldownMs: POST_REPORT_COOLDOWN_MS,
      conflictMessage: POST_REPORT_COOLDOWN_MESSAGE,
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

    return report as CreatedReportDocument;
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
  }): Promise<CreatedReportDocument> {
    await this.acquireReportCooldown({
      session,
      reporterId,
      targetType: ReportTargetType.USER,
      targetId: targetUser._id,
      cooldownMs: USER_REPORT_COOLDOWN_MS,
      conflictMessage: USER_REPORT_COOLDOWN_MESSAGE,
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

    return report as CreatedReportDocument;
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

  private async assertReportCooldownAvailable(options: {
    reporterId: Types.ObjectId;
    targetType: ReportTargetType;
    targetId: Types.ObjectId;
    conflictMessage: string;
  }): Promise<void> {
    const activeCooldown = await this.reportCooldownModel
      .findOne({
        reporterId: options.reporterId,
        targetType: options.targetType,
        targetId: options.targetId,
        nextAllowedAt: { $gt: new Date() },
      })
      .select('_id')
      .lean()
      .exec();

    if (activeCooldown) {
      throw new ConflictException(options.conflictMessage);
    }
  }
}
