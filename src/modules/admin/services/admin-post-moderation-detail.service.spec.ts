import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { PostModerationState } from '../../posts/schemas/post.schema';
import {
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../reports/schemas/report.schema';
import { AdminPostModerationTargetState } from '../interfaces/admin-post-moderation-detail.interface';
import { AdminPostModerationDetailService } from './admin-post-moderation-detail.service';

const query = (result: unknown) => {
  const value = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  value.select.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
};

const reportId = 'rpt_23456789ABCDEFGH';
const targetId = new Types.ObjectId();
const reporterId = new Types.ObjectId();
const authorId = new Types.ObjectId();
const expireAt = new Date(Date.now() + 60_000);

const storedReport = () => ({
  publicId: reportId,
  reporterId,
  targetId,
  targetType: ReportTargetType.POST,
  reasonCode: 'violence_hate',
  reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
  reasonTaxonomyVersion: 1,
  reasonDetail: 'internal label',
  description: 'reporter private description',
  status: ReportStatus.REVIEWING,
  adminNote: 'secret admin note',
  targetSnapshot: {
    publicId: 'post_23456789ABCD',
    authorId,
    authorUsername: 'snapshot_author',
    content: 'immutable snapshot content',
    images: [
      {
        url: 'https://res.cloudinary.com/betta/image/upload/v1/post.webp',
        publicId: 'cloudinary-secret-public-id',
      },
    ],
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
    expireAt,
  },
});

const serviceWith = (report: unknown, post: unknown) => {
  const reportQuery = query(report);
  const postQuery = query(post);
  const reports = {
    findOne: jest.fn<(filter: unknown) => typeof reportQuery>(
      () => reportQuery,
    ),
  };
  const posts = {
    findById: jest.fn<(id: unknown) => typeof postQuery>(() => postQuery),
  };
  return {
    reports,
    posts,
    reportQuery,
    postQuery,
    service: new AdminPostModerationDetailService(
      reports as never,
      posts as never,
    ),
  };
};

describe('AdminPostModerationDetailService', () => {
  it('returns snapshot evidence only and never serializes internal fields', async () => {
    const { service, reports, posts, reportQuery, postQuery } = serviceWith(
      storedReport(),
      {
        publicId: 'post_live_should_not_be_returned',
        authorId: new Types.ObjectId(),
        content: 'live mutable content',
        images: [{ url: 'https://attacker.test/live' }],
        expireAt,
        moderationState: PostModerationState.ACTIVE,
        isDeletedByAdmin: false,
      },
    );

    const result = await service.getByReportPublicId(reportId);

    expect(result).toMatchObject({
      reportPublicId: reportId,
      reportStatus: ReportStatus.REVIEWING,
      target: {
        publicId: 'post_23456789ABCD',
        state: AdminPostModerationTargetState.AVAILABLE,
      },
      evidence: {
        authorUsername: 'snapshot_author',
        content: 'immutable snapshot content',
        media: [
          {
            url: 'https://res.cloudinary.com/betta/image/upload/v1/post.webp',
            redacted: false,
          },
        ],
        evidenceUnavailable: false,
      },
    });
    expect(reports.findOne).toHaveBeenCalledWith({
      publicId: reportId,
      targetType: ReportTargetType.POST,
    });
    expect(posts.findById).toHaveBeenCalledWith(targetId);
    expect(reportQuery.select).toHaveBeenCalledTimes(1);
    expect(postQuery.select).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      reporterId.toHexString(),
      targetId.toHexString(),
      authorId.toHexString(),
      'secret admin note',
      'reporter private description',
      'cloudinary-secret-public-id',
      'live mutable content',
      'post_live_should_not_be_returned',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    [
      'hidden',
      {
        expireAt,
        moderationState: PostModerationState.HIDDEN,
        isDeletedByAdmin: false,
      },
      AdminPostModerationTargetState.HIDDEN,
    ],
    [
      'expired',
      {
        expireAt: new Date(Date.now() - 60_000),
        moderationState: PostModerationState.HIDDEN,
        isDeletedByAdmin: false,
      },
      AdminPostModerationTargetState.EXPIRED,
    ],
    [
      'deleted',
      {
        expireAt,
        moderationState: PostModerationState.TERMINAL_DELETED,
        isDeletedByAdmin: true,
      },
      AdminPostModerationTargetState.DELETED,
    ],
    ['missing', null, AdminPostModerationTargetState.UNAVAILABLE],
  ])('maps %s target without reviving the Post', async (_name, post, state) => {
    const { service } = serviceWith(storedReport(), post);
    const result = await service.getByReportPublicId(reportId);
    expect(result.target.state).toBe(state);
    expect(result.evidence.content).toBe('immutable snapshot content');
  });

  it('redacts non-allowlisted, credentialed and malformed media URLs', async () => {
    const report = storedReport();
    report.targetSnapshot.images = [
      { url: 'https://evil.test/image.webp', publicId: 'evil-1' },
      {
        url: 'https://user:pass@res.cloudinary.com/betta/image/upload/x.webp',
        publicId: 'evil-2',
      },
      {
        url: 'https://res.cloudinary.com/betta/raw/upload/x.txt',
        publicId: 'evil-3',
      },
      { url: 'not-a-url', publicId: 'evil-4' },
    ];
    const { service } = serviceWith(report, {
      expireAt,
      moderationState: PostModerationState.ACTIVE,
    });

    const result = await service.getByReportPublicId(reportId);

    expect(result.evidence.media).toEqual([
      { url: null, redacted: true },
      { url: null, redacted: true },
      { url: null, redacted: true },
      { url: null, redacted: true },
    ]);
    expect(result.evidence.evidenceUnavailable).toBe(true);
  });

  it('returns a safe empty payload after retention purges full evidence', async () => {
    const report = {
      ...storedReport(),
      evidencePurgedAt: new Date('2026-08-01T00:00:00.000Z'),
      evidenceUnavailable: true,
      targetSnapshot: {
        publicId: 'post_23456789ABCD',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        expireAt: new Date('2026-06-02T00:00:00.000Z'),
      },
    };
    const { service } = serviceWith(report, null);

    const result = await service.getByReportPublicId(reportId);

    expect(result.evidence).toMatchObject({
      authorUsername: null,
      content: '',
      media: [],
      evidenceUnavailable: true,
    });
    expect(result.target.publicId).toBe('post_23456789ABCD');
  });

  it('rejects malformed and missing/non-Post report identifiers safely', async () => {
    const invalid = serviceWith(null, null);
    await expect(
      invalid.service.getByReportPublicId('not-a-report-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(invalid.reports.findOne).not.toHaveBeenCalled();

    await expect(
      invalid.service.getByReportPublicId(reportId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
