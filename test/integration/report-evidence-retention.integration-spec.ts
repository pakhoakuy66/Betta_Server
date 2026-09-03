import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createConnection, type Connection, type Model, Types } from 'mongoose';
import type { AdminPolicy } from '../../src/modules/admin/config/admin-policy.config';
import { REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE } from '../../src/modules/admin/constants/admin-post-moderation-detail.constants';
import { ExpiredPostCleanupService } from '../../src/modules/cron/services/expired-post-cleanup.service';
import {
  Post,
  PostCleanupStatus,
  PostSchema,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import { RetentionCleanupStatus } from '../../src/modules/reports/schemas/report-retention.schema';
import {
  Report,
  ReportReasonGroup,
  ReportSchema,
  ReportStatus,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportSchema,
  SystemReportSource,
  SystemReportStatus,
  SystemReportType,
} from '../../src/modules/reports/schemas/system-report.schema';
import { generateReportPublicId } from '../../src/modules/reports/utils/generate-report-public-id';
import { generateSystemReportPublicId } from '../../src/modules/reports/utils/generate-system-report-public-id';
import { ReportEvidenceRetentionService } from '../../src/modules/retention/report-evidence-retention.service';
import type { CloudinaryAssetHealthService } from '../../src/modules/uploads/services/cloudinary-asset-health.service';
import type { UploadsService } from '../../src/modules/uploads/services/uploads.service';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_ret08_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID()
  .replace(/-/gu, '')
  .slice(0, 6)}`;
const NOW = new Date('2026-08-29T12:00:00.000Z');
const DAY_MS = 86_400_000;

type DeleteImages = (
  publicIds: string[],
  options?: { throwOnError?: boolean },
) => Promise<void>;

type FindMissingImagePublicIds = (
  publicIds: readonly string[],
) => Promise<string[]>;

type RawReportRecord = Readonly<{
  evidenceUnavailable?: boolean;
  evidencePurgedAt?: Date | null;
  description?: string;
  targetSnapshot?: Readonly<{
    content?: string;
    images?: readonly unknown[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}>;

jest.setTimeout(120_000);

describe('ADM-MOD-08 report evidence retention MongoDB integration', () => {
  let connection: Connection;
  let reports: Model<Report>;
  let systemReports: Model<SystemReport>;
  let posts: Model<Post>;
  let users: Model<User>;
  let service: ReportEvidenceRetentionService;
  const deleteImages = jest.fn<DeleteImages>();
  const findMissingImagePublicIds = jest.fn<FindMissingImagePublicIds>();

  const dateBefore = (days: number): Date =>
    new Date(NOW.getTime() - days * DAY_MS);

  const createReport = async (
    options: {
      status?: ReportStatus;
      terminalAt?: Date | null;
      targetId?: Types.ObjectId;
      hold?: { owner: string; reason: string; expiresAt: Date };
    } = {},
  ): Promise<Report> => {
    const targetId = options.targetId ?? new Types.ObjectId();
    return reports.create({
      publicId: generateReportPublicId(),
      reporterId: new Types.ObjectId(),
      targetType: ReportTargetType.POST,
      targetId,
      reasonCode: 'violence_hate',
      reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
      reasonTaxonomyVersion: 1,
      reasonDetail: 'internal reason detail',
      description: 'private reporter narrative',
      status: options.status ?? ReportStatus.RESOLVED,
      terminalAt: options.terminalAt ?? dateBefore(31),
      adminNote: 'private admin note',
      retentionHold: options.hold ?? null,
      targetSnapshot: {
        publicId: generatePostPublicId(),
        authorId: new Types.ObjectId(),
        authorUsername: 'snapshot_author',
        content: 'immutable text evidence',
        images: [
          {
            url: 'https://res.cloudinary.com/betta/image/upload/v1/evidence.webp',
            publicId: 'snapshot-private-public-id',
          },
        ],
        createdAt: dateBefore(50),
        expireAt: dateBefore(49),
      },
    });
  };

  const createSystemReport = async (
    options: {
      terminalAt?: Date;
      hold?: { owner: string; reason: string; expiresAt: Date };
      evidencePurgedAt?: Date;
      cleanupStatus?: RetentionCleanupStatus;
    } = {},
  ): Promise<SystemReport> => {
    const publicId = generateSystemReportPublicId();
    return systemReports.create({
      publicId,
      reporterId: new Types.ObjectId(),
      source: SystemReportSource.AUTH_PUBLIC,
      reportType: SystemReportType.ACCOUNT_ACCESS,
      category: 'LOGIN_PROBLEM',
      encryptedContactEmail: 'ciphertext-contact',
      contactEmailMasked: 'c***@e***.com',
      contactLookupHmac: `contact-hmac-${publicId}`,
      encryptedAccountIdentifier: 'ciphertext-identifier',
      requestFingerprintHmac: `fingerprint-${publicId}`,
      correlationId: `corr-${publicId}`,
      description: 'Sensitive support evidence narrative',
      descriptionHash: `description-hash-${publicId}`,
      dedupeKey: `dedupe-${publicId}`,
      evidenceImages: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/support.webp',
          publicId: `support-evidence-${publicId}`,
        },
      ],
      status: SystemReportStatus.FIXED,
      terminalAt: options.terminalAt ?? dateBefore(31),
      adminNote: 'private support note',
      retentionHold: options.hold ?? null,
      evidencePurgedAt: options.evidencePurgedAt ?? null,
      retentionCleanupStatus:
        options.cleanupStatus ?? RetentionCleanupStatus.PENDING,
    });
  };

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI không được trùng runtime URI');
    }
    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > 38
    ) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();
    reports = connection.model(Report.name, ReportSchema);
    systemReports = connection.model(SystemReport.name, SystemReportSchema);
    posts = connection.model(Post.name, PostSchema);
    users = connection.model(User.name, UserSchema);
    await Promise.all([
      reports.syncIndexes(),
      systemReports.syncIndexes(),
      posts.syncIndexes(),
      users.syncIndexes(),
    ]);
    service = new ReportEvidenceRetentionService(
      reports,
      systemReports,
      posts,
      { deleteImages } as unknown as UploadsService,
      { findMissingImagePublicIds } as unknown as CloudinaryAssetHealthService,
    );
  });

  beforeEach(async () => {
    deleteImages.mockReset();
    deleteImages.mockResolvedValue();
    findMissingImagePublicIds.mockReset();
    findMissingImagePublicIds.mockResolvedValue([]);
    await Promise.all([
      reports.collection.deleteMany({}),
      systemReports.collection.deleteMany({}),
      posts.collection.deleteMany({}),
      users.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Từ chối xóa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('purges only terminal evidence at the 30-day boundary and is idempotent', async () => {
    const open = await createReport({
      status: ReportStatus.REVIEWING,
      terminalAt: null,
    });
    const inGrace = await createReport({ terminalAt: dateBefore(29) });
    const boundary = await createReport({ terminalAt: dateBefore(30) });
    const activeHold = await createReport({
      terminalAt: dateBefore(40),
      hold: {
        owner: 'legal-team',
        reason: 'Active preservation request',
        expiresAt: new Date(NOW.getTime() + 10 * DAY_MS),
      },
    });
    const expiredHold = await createReport({
      terminalAt: dateBefore(40),
      hold: {
        owner: 'security-team',
        reason: 'Expired investigation hold',
        expiresAt: dateBefore(1),
      },
    });

    const dryRun = await service.purgeReportEvidence(10, false, NOW);
    expect(dryRun).toMatchObject({ planned: 2, processed: 0, updated: 0 });
    expect(
      (await reports.collection.findOne({ _id: boundary._id }))?.description,
    ).toBe('private reporter narrative');

    const executed = await service.purgeReportEvidence(10, true, NOW);
    expect(executed).toMatchObject({ processed: 2, updated: 2, failed: 0 });

    for (const id of [boundary._id, expiredHold._id]) {
      const stored = (await reports.collection.findOne({
        _id: id,
      })) as RawReportRecord | null;
      expect(stored).toMatchObject({
        evidenceUnavailable: true,
        evidencePurgedAt: NOW,
        retentionCleanupStatus: RetentionCleanupStatus.CLEANED,
        reasonCode: 'violence_hate',
      });
      expect(stored?.targetSnapshot).toMatchObject({
        publicId: expect.stringMatching(/^post_/u),
      });
      for (const forbidden of [
        'reporterId',
        'reasonDetail',
        'description',
        'adminNote',
      ]) {
        expect(stored).not.toHaveProperty(forbidden);
      }
      for (const forbidden of [
        'authorId',
        'authorUsername',
        'content',
        'images',
      ]) {
        expect(stored?.targetSnapshot).not.toHaveProperty(forbidden);
      }
    }

    for (const id of [open._id, inGrace._id, activeHold._id]) {
      const stored = (await reports.collection.findOne({
        _id: id,
      })) as RawReportRecord | null;
      expect(stored?.targetSnapshot?.content).toBe('immutable text evidence');
      expect(stored?.evidencePurgedAt ?? null).toBeNull();
    }

    await expect(
      service.purgeReportEvidence(10, true, NOW),
    ).resolves.toMatchObject({
      processed: 0,
      updated: 0,
    });
    await expect(
      reports.updateOne(
        { _id: boundary._id },
        { $set: { 'targetSnapshot.content': 'must stay blocked' } },
      ),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);
  });

  it('fences System Report physical deletion and sends ambiguous failure to manual review', async () => {
    const report = await createSystemReport();
    deleteImages.mockRejectedValueOnce(new Error('Cloudinary unavailable'));

    await expect(
      service.purgeSystemReportEvidence(1, true, NOW),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 0,
      manualReview: 1,
      updated: 0,
    });
    expect(
      (await systemReports.collection.findOne({ _id: report._id }))
        ?.retentionCleanupStatus,
    ).toBe(RetentionCleanupStatus.MANUAL_REVIEW);

    await expect(
      service.purgeSystemReportEvidence(1, true, NOW),
    ).resolves.toMatchObject({ processed: 0 });
    expect(deleteImages).toHaveBeenCalledTimes(1);
    expect(deleteImages).toHaveBeenCalledWith(
      [`support-evidence-${report.publicId}`],
      { throwOnError: true },
    );
  });

  it('purges System Report attachments and private fields after winning reservation', async () => {
    const report = await createSystemReport();

    await expect(
      service.purgeSystemReportEvidence(1, true, NOW),
    ).resolves.toMatchObject({ processed: 1, updated: 1, failed: 0 });

    const stored = await systemReports.collection.findOne({ _id: report._id });
    expect(stored).toMatchObject({
      publicId: report.publicId,
      evidenceImages: [],
      evidenceUnavailable: true,
      retentionCleanupStatus: RetentionCleanupStatus.CLEANED,
    });
    for (const forbidden of [
      'reporterId',
      'encryptedContactEmail',
      'contactEmailMasked',
      'contactLookupHmac',
      'encryptedAccountIdentifier',
      'requestFingerprintHmac',
      'description',
      'descriptionHash',
      'dedupeKey',
      'adminNote',
    ]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it('never reclaims an expired System Report lease after destructive reservation', async () => {
    const report = await createSystemReport();
    await systemReports.collection.updateOne(
      { _id: report._id },
      {
        $set: {
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockToken: 'stale-owner-token',
          retentionLockedUntil: dateBefore(1),
          retentionDestructiveStartedAt: dateBefore(1),
          retentionAttempts: 1,
        },
      },
    );

    await expect(
      service.purgeSystemReportEvidence(1, true, NOW),
    ).resolves.toMatchObject({ processed: 0, updated: 0 });
    expect(deleteImages).not.toHaveBeenCalled();

    await expect(
      service.reconcileExhaustedClaims(1, true, NOW),
    ).resolves.toMatchObject({ processed: 1, manualReview: 1 });
    expect(
      (await systemReports.collection.findOne({ _id: report._id }))
        ?.retentionCleanupStatus,
    ).toBe(RetentionCleanupStatus.MANUAL_REVIEW);
  });

  it('keeps safe records searchable until 365 days then deletes hold-aware', async () => {
    const deletableReport = await createReport({ terminalAt: dateBefore(400) });
    const heldReport = await createReport({
      terminalAt: dateBefore(400),
      hold: {
        owner: 'legal-team',
        reason: 'Litigation preservation',
        expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      },
    });
    await reports.collection.updateMany(
      { _id: { $in: [deletableReport._id, heldReport._id] } },
      {
        $set: {
          evidencePurgedAt: dateBefore(360),
          evidenceUnavailable: true,
          retentionCleanupStatus: RetentionCleanupStatus.CLEANED,
        },
      },
    );
    const deletableSystem = await createSystemReport({
      terminalAt: dateBefore(400),
      evidencePurgedAt: dateBefore(360),
      cleanupStatus: RetentionCleanupStatus.CLEANED,
    });

    await expect(
      service.deleteSafeReportMetadata(10, true, NOW),
    ).resolves.toMatchObject({ deleted: 1, failed: 0 });
    await expect(
      service.deleteSafeSystemReportMetadata(10, true, NOW),
    ).resolves.toMatchObject({ deleted: 1, failed: 0 });

    expect(await reports.findById(deletableReport._id)).toBeNull();
    expect(await reports.findById(heldReport._id)).not.toBeNull();
    expect(await systemReports.findById(deletableSystem._id)).toBeNull();
  });

  it('marks evidence unavailable when the target Post document is missing', async () => {
    const report = await createReport({
      status: ReportStatus.REVIEWING,
      terminalAt: null,
      targetId: new Types.ObjectId(),
    });

    await expect(
      service.reconcileMissingPostEvidence(10, true, NOW),
    ).resolves.toMatchObject({ processed: 1, updated: 1 });

    const stored = (await reports.collection.findOne({
      _id: report._id,
    })) as RawReportRecord | null;
    expect(stored?.evidenceUnavailable).toBe(true);
    expect(stored?.targetSnapshot?.content).toBe('immutable text evidence');
    expect(stored?.targetSnapshot?.images).toHaveLength(1);
  });

  it('detects missing Cloudinary media while the target Post still exists', async () => {
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'Existing target with missing physical media',
      images: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/evidence.webp',
          publicId: 'snapshot-private-public-id',
        },
      ],
      expireAt: new Date(NOW.getTime() + DAY_MS),
    });
    const report = await createReport({
      status: ReportStatus.REVIEWING,
      terminalAt: null,
      targetId: post._id,
    });
    findMissingImagePublicIds.mockResolvedValue(['snapshot-private-public-id']);

    await expect(
      service.reconcileMissingPostEvidence(10, true, NOW),
    ).resolves.toMatchObject({ processed: 1, updated: 1, failed: 0 });

    const stored = (await reports.collection.findOne({
      _id: report._id,
    })) as RawReportRecord | null;
    expect(stored?.evidenceUnavailable).toBe(true);
    expect(stored?.targetSnapshot?.content).toBe('immutable text evidence');
    expect(findMissingImagePublicIds).toHaveBeenCalledWith([
      'snapshot-private-public-id',
    ]);
  });

  it('fails closed when Cloudinary health cannot be established', async () => {
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'Existing target during Cloudinary outage',
      expireAt: new Date(NOW.getTime() + DAY_MS),
    });
    const report = await createReport({
      status: ReportStatus.REVIEWING,
      terminalAt: null,
      targetId: post._id,
    });
    findMissingImagePublicIds.mockRejectedValue(
      new Error('Cloudinary Admin API unavailable'),
    );

    await expect(
      service.reconcileMissingPostEvidence(10, true, NOW),
    ).resolves.toMatchObject({ processed: 1, updated: 0, failed: 1 });
    expect(
      (await reports.collection.findOne({ _id: report._id }))
        ?.evidenceUnavailable,
    ).toBe(false);
  });

  it('defers physical Post cleanup for the latest terminal report and active hold', async () => {
    const user = await users.create({
      publicId: `usr_ret08_${randomUUID().slice(0, 8)}`,
      username: `ret08_${randomUUID().slice(0, 8)}`,
      fullname: 'Retention User',
      phone: `08${Math.floor(Math.random() * 1e8)
        .toString()
        .padStart(8, '0')}`,
      email: `ret08_${randomUUID().slice(0, 8)}@example.com`,
      password: 'integration-password-hash',
      status: 'active',
      isDeleted: false,
      postsCount: 1,
    });
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: user._id,
      content: 'Post held as original evidence',
      images: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/original.webp',
          publicId: 'original-post-media',
        },
      ],
      expireAt: dateBefore(1),
      cleanupStatus: PostCleanupStatus.PENDING,
    });
    await createReport({ targetId: post._id, terminalAt: dateBefore(40) });
    const latest = await createReport({
      targetId: post._id,
      terminalAt: dateBefore(5),
      hold: {
        owner: 'security-team',
        reason: 'Active incident investigation',
        expiresAt: new Date(NOW.getTime() + 60 * DAY_MS),
      },
    });
    const policy = {
      retention: { reportEvidenceGraceDays: 30 },
    } as AdminPolicy;
    const cleanup = new ExpiredPostCleanupService(
      posts,
      users,
      { deleteImages } as unknown as UploadsService,
      reports,
      policy,
    );

    const result = await cleanup.cleanupExpiredPosts();

    expect(result).toEqual({ processed: 1, deleted: 0, failed: 0 });
    const retained = await posts
      .findById(post._id)
      .select('+evidenceHoldUntil')
      .lean<{ evidenceHoldUntil: Date }>()
      .exec();
    expect(retained?.evidenceHoldUntil).toEqual(
      latest.retentionHold?.expiresAt,
    );
    expect(deleteImages).not.toHaveBeenCalled();
  });

  it('fences an expired in-flight Post reservation without repeating physical deletion', async () => {
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'Expired Post protected by destructive fencing',
      images: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/post.webp',
          publicId: 'post-physical-media',
        },
      ],
      expireAt: dateBefore(1),
      cleanupStatus: PostCleanupStatus.PENDING,
    });
    const policy = {
      retention: { reportEvidenceGraceDays: 30 },
    } as AdminPolicy;
    const cleanup = new ExpiredPostCleanupService(
      posts,
      users,
      { deleteImages } as unknown as UploadsService,
      reports,
      policy,
    );
    let releaseDeletion!: () => void;
    let deletionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    deleteImages.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDeletion = resolve;
          deletionStarted();
        }),
    );

    const firstRun = cleanup.cleanupExpiredPosts();
    await started;
    await posts.collection.updateOne(
      { _id: post._id },
      { $set: { cleanupLockedUntil: dateBefore(1) } },
    );

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
    const fencedPost = await posts
      .findById(post._id)
      .select('+cleanupDestructiveStartedAt +cleanupLockToken')
      .lean()
      .exec();
    expect(fencedPost).toMatchObject({
      cleanupStatus: PostCleanupStatus.MANUAL_REVIEW,
      cleanupLockedUntil: null,
      cleanupLockToken: null,
      cleanupLastError: 'STALE_DESTRUCTIVE_RESERVATION',
    });
    expect(fencedPost?.cleanupDestructiveStartedAt).toBeInstanceOf(Date);
    expect(deleteImages).toHaveBeenCalledTimes(1);

    releaseDeletion();
    await expect(firstRun).resolves.toEqual({
      processed: 1,
      deleted: 0,
      failed: 1,
    });
    expect(deleteImages).toHaveBeenCalledTimes(1);
    await expect(posts.exists({ _id: post._id })).resolves.not.toBeNull();
  });

  it('moves an ambiguous Post media deletion failure to manual review', async () => {
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'Expired Post with ambiguous Cloudinary failure',
      images: [
        {
          url: 'https://res.cloudinary.com/betta/image/upload/v1/post.webp',
          publicId: 'post-ambiguous-media',
        },
      ],
      expireAt: dateBefore(1),
      cleanupStatus: PostCleanupStatus.PENDING,
    });
    const cleanup = new ExpiredPostCleanupService(
      posts,
      users,
      { deleteImages } as unknown as UploadsService,
      reports,
      { retention: { reportEvidenceGraceDays: 30 } } as AdminPolicy,
    );
    deleteImages.mockRejectedValueOnce(new Error('Cloudinary timeout'));

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 1,
      deleted: 0,
      failed: 1,
    });
    expect(
      (await posts.collection.findOne({ _id: post._id }))?.cleanupStatus,
    ).toBe(PostCleanupStatus.MANUAL_REVIEW);

    await expect(cleanup.cleanupExpiredPosts()).resolves.toEqual({
      processed: 0,
      deleted: 0,
      failed: 0,
    });
    expect(deleteImages).toHaveBeenCalledTimes(1);
  });

  it('validates structured holds and declares no native TTL indexes', async () => {
    await expect(
      createReport({
        hold: {
          owner: '',
          reason: 'Missing owner must be rejected',
          expiresAt: new Date(NOW.getTime() + DAY_MS),
        },
      }),
    ).rejects.toThrow();

    const allIndexes = [
      ...ReportSchema.indexes(),
      ...SystemReportSchema.indexes(),
    ];
    expect(
      allIndexes.some(([, options]) => 'expireAfterSeconds' in options),
    ).toBe(false);
  });
});
