import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { Post, PostModerationState } from '../../posts/schemas/post.schema';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import { isReportPublicId } from '../../reports/utils/generate-report-public-id';
import {
  ADMIN_POST_MODERATION_MEDIA_ALLOWED_HOSTS,
  ADMIN_POST_MODERATION_MEDIA_PATH_PATTERN,
} from '../constants/admin-post-moderation-detail.constants';
import {
  AdminPostModerationTargetState,
  type PublicAdminPostEvidenceMedia,
  type PublicAdminPostModerationDetail,
} from '../interfaces/admin-post-moderation-detail.interface';

type StoredSnapshotImage = Readonly<{ url?: unknown }>;

type StoredTargetSnapshot = Readonly<{
  publicId?: unknown;
  authorUsername?: unknown;
  content?: unknown;
  images?: unknown;
  createdAt?: unknown;
  expireAt?: unknown;
}>;

type StoredReport = Readonly<{
  publicId: string;
  targetId: Types.ObjectId;
  targetType: ReportTargetType;
  reasonCode: string | null;
  reasonGroup: ReportReasonGroup;
  reasonTaxonomyVersion: number | null;
  status: ReportStatus;
  evidencePurgedAt?: unknown;
  evidenceUnavailable?: unknown;
  targetSnapshot?: StoredTargetSnapshot;
}>;

type StoredPostState = Readonly<{
  expireAt?: Date | null;
  moderationState?: PostModerationState;
  isDeletedByAdmin?: boolean;
}>;

const REPORT_PROJECTION = Object.freeze({
  _id: 0,
  publicId: 1,
  targetId: 1,
  targetType: 1,
  reasonCode: 1,
  reasonGroup: 1,
  reasonTaxonomyVersion: 1,
  status: 1,
  evidencePurgedAt: 1,
  evidenceUnavailable: 1,
  'targetSnapshot.publicId': 1,
  'targetSnapshot.authorUsername': 1,
  'targetSnapshot.content': 1,
  'targetSnapshot.images.url': 1,
  'targetSnapshot.createdAt': 1,
  'targetSnapshot.expireAt': 1,
});

const POST_STATE_PROJECTION = Object.freeze({
  _id: 0,
  expireAt: 1,
  moderationState: 1,
  isDeletedByAdmin: 1,
});

const MEDIA_HOSTS = new Set<string>(ADMIN_POST_MODERATION_MEDIA_ALLOWED_HOSTS);

@Injectable()
export class AdminPostModerationDetailService {
  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

  async getByReportPublicId(
    publicId: string,
  ): Promise<PublicAdminPostModerationDetail> {
    if (!isReportPublicId(publicId)) {
      throw new BadRequestException('Report publicId không hợp lệ');
    }

    const report = (await this.reports
      .findOne({ publicId, targetType: ReportTargetType.POST })
      .select(REPORT_PROJECTION)
      .lean()
      .exec()) as StoredReport | null;

    if (!report) {
      throw new NotFoundException('Không tìm thấy report Post');
    }

    const post = await this.readPostState(report.targetId);
    return this.toPublicDetail(report, post, new Date());
  }

  private async readPostState(
    targetId: Types.ObjectId,
  ): Promise<StoredPostState | null> {
    if (!Types.ObjectId.isValid(targetId)) return null;
    return (await this.posts
      .findById(targetId)
      .select(POST_STATE_PROJECTION)
      .lean()
      .exec()) as StoredPostState | null;
  }

  private toPublicDetail(
    report: StoredReport,
    post: StoredPostState | null,
    now: Date,
  ): PublicAdminPostModerationDetail {
    const snapshot = report.targetSnapshot ?? {};
    const media = this.publicMedia(snapshot.images);
    const targetState = this.targetState(post, now);

    return Object.freeze({
      reportPublicId: report.publicId,
      reportStatus: report.status,
      reason: Object.freeze({
        code: report.reasonCode ?? report.reasonGroup,
        group: report.reasonGroup,
        taxonomyVersion: Number.isSafeInteger(report.reasonTaxonomyVersion)
          ? report.reasonTaxonomyVersion
          : null,
      }),
      target: Object.freeze({
        publicId: this.nonEmptyString(snapshot.publicId),
        state: targetState,
      }),
      evidence: Object.freeze({
        authorUsername: this.nonEmptyString(snapshot.authorUsername),
        content: typeof snapshot.content === 'string' ? snapshot.content : '',
        media,
        createdAt: this.isoDate(snapshot.createdAt),
        expireAt: this.isoDate(snapshot.expireAt),
        evidenceUnavailable:
          report.evidenceUnavailable === true ||
          report.evidencePurgedAt instanceof Date ||
          media.some(({ redacted }) => redacted),
      }),
    });
  }

  private targetState(
    post: StoredPostState | null,
    now: Date,
  ): AdminPostModerationTargetState {
    if (!post) return AdminPostModerationTargetState.UNAVAILABLE;
    if (post.moderationState === PostModerationState.TERMINAL_DELETED) {
      return AdminPostModerationTargetState.DELETED;
    }
    if (
      post.expireAt instanceof Date &&
      post.expireAt.getTime() <= now.getTime()
    ) {
      return AdminPostModerationTargetState.EXPIRED;
    }
    if (post.moderationState === PostModerationState.HIDDEN) {
      return AdminPostModerationTargetState.HIDDEN;
    }
    if (post.isDeletedByAdmin === true) {
      return AdminPostModerationTargetState.DELETED;
    }
    return AdminPostModerationTargetState.AVAILABLE;
  }

  private publicMedia(value: unknown): readonly PublicAdminPostEvidenceMedia[] {
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(
      value.map((item) =>
        this.publicMediaItem((item as StoredSnapshotImage | null)?.url),
      ),
    );
  }

  private publicMediaItem(value: unknown): PublicAdminPostEvidenceMedia {
    if (typeof value !== 'string') return this.redactedMedia();
    try {
      const url = new URL(value);
      const allowed =
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.port === '' &&
        url.search === '' &&
        url.hash === '' &&
        MEDIA_HOSTS.has(url.hostname) &&
        ADMIN_POST_MODERATION_MEDIA_PATH_PATTERN.test(url.pathname);
      return allowed
        ? Object.freeze({ url: url.href, redacted: false })
        : this.redactedMedia();
    } catch {
      return this.redactedMedia();
    }
  }

  private redactedMedia(): PublicAdminPostEvidenceMedia {
    return Object.freeze({ url: null, redacted: true });
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private isoDate(value: unknown): string | null {
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : null;
  }
}
