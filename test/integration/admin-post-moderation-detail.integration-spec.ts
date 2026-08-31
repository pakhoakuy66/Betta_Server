import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  jest,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { MongooseModule } from '@nestjs/mongoose';
import { type Connection, type Model, Types } from 'mongoose';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import { REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE } from '../../src/modules/admin/constants/admin-post-moderation-detail.constants';
import { AdminPostModerationDetailController } from '../../src/modules/admin/controllers/admin-post-moderation-detail.controller';
import { ADMIN_PERMISSIONS_METADATA } from '../../src/modules/admin/decorators/require-admin-permissions.decorator';
import { AdminPostModerationTargetState } from '../../src/modules/admin/interfaces/admin-post-moderation-detail.interface';
import { AdminPostModerationDetailService } from '../../src/modules/admin/services/admin-post-moderation-detail.service';
import {
  Post,
  PostModerationState,
  PostSchema,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import {
  Report,
  ReportReasonGroup,
  ReportSchema,
  ReportStatus,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import { generateReportPublicId } from '../../src/modules/reports/utils/generate-report-public-id';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const DATABASE_PREFIX = 'betta_apmd_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID()
  .replace(/-/gu, '')
  .slice(0, 8)}`;

jest.setTimeout(120_000);

describe('Admin post moderation detail MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let reports: Model<Report>;
  let posts: Model<Post>;
  let service: AdminPostModerationDetailService;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chua duoc cau hinh`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES la bat buoc`);
    }
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI khong duoc trung runtime URI');
    }
    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > 38
    ) {
      throw new Error('Ten integration database khong an toan');
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(uri, {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        MongooseModule.forFeature([
          { name: Report.name, schema: ReportSchema },
          { name: Post.name, schema: PostSchema },
        ]),
      ],
      providers: [AdminPostModerationDetailService],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    reports = moduleRef.get<Model<Report>>(getModelToken(Report.name));
    posts = moduleRef.get<Model<Post>>(getModelToken(Post.name));
    service = moduleRef.get(AdminPostModerationDetailService);
    await Promise.all([reports.syncIndexes(), posts.syncIndexes()]);
  });

  beforeEach(async () => {
    await Promise.all([
      reports.collection.deleteMany({}),
      posts.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(DATABASE_PREFIX)) {
        throw new Error(`Tu choi xoa database: ${connection.name}`);
      }
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const createPost = async (
    state: PostModerationState,
    expireAt: Date,
    isDeletedByAdmin = false,
  ): Promise<Post> =>
    (await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'live post content must never become evidence',
      images: [
        {
          url: 'https://evil.test/live.webp',
          publicId: 'live-cloudinary-public-id',
        },
      ],
      expireAt,
      moderationState: state,
      isDeletedByAdmin,
    })) as Post;

  const createReport = async (
    post: Post,
    images: Array<{ url: string; publicId: string }> = [
      {
        url: 'https://res.cloudinary.com/betta/image/upload/v1/evidence.webp',
        publicId: 'snapshot-cloudinary-public-id',
      },
    ],
  ): Promise<Report> =>
    (await reports.create({
      publicId: generateReportPublicId(),
      reporterId: new Types.ObjectId(),
      targetType: ReportTargetType.POST,
      targetId: post._id,
      reasonCode: 'violence_hate',
      reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
      reasonTaxonomyVersion: 1,
      reasonDetail: 'canonical internal label',
      description: 'private reporter narrative',
      status: ReportStatus.REVIEWING,
      adminNote: 'private admin note',
      targetSnapshot: {
        publicId: post.publicId,
        authorId: post.authorId,
        authorUsername: 'snapshot_author',
        content: 'immutable snapshot evidence',
        images,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        expireAt: post.expireAt,
      },
    })) as Report;

  it('returns active snapshot evidence with allowlisted media only', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post);

    const result = await service.getByReportPublicId(report.publicId ?? '');

    expect(result).toMatchObject({
      reportPublicId: report.publicId,
      reportStatus: ReportStatus.REVIEWING,
      target: {
        publicId: post.publicId,
        state: AdminPostModerationTargetState.AVAILABLE,
      },
      evidence: {
        authorUsername: 'snapshot_author',
        content: 'immutable snapshot evidence',
        media: [
          {
            url: 'https://res.cloudinary.com/betta/image/upload/v1/evidence.webp',
            redacted: false,
          },
        ],
        evidenceUnavailable: false,
      },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      report._id.toHexString(),
      post._id.toHexString(),
      report.reporterId.toHexString(),
      post.authorId.toHexString(),
      'private reporter narrative',
      'private admin note',
      'snapshot-cloudinary-public-id',
      'live-cloudinary-public-id',
      'live post content must never become evidence',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('maps hidden, expired, deleted and physically missing targets', async () => {
    const future = new Date(Date.now() + 60_000);
    const hidden = await createPost(PostModerationState.HIDDEN, future);
    const expired = await createPost(
      PostModerationState.HIDDEN,
      new Date(Date.now() - 60_000),
    );
    const deleted = await createPost(
      PostModerationState.TERMINAL_DELETED,
      future,
      true,
    );
    const missing = await createPost(PostModerationState.ACTIVE, future);
    const targetReports = await Promise.all(
      [hidden, expired, deleted, missing].map((post) => createReport(post)),
    );
    await posts.deleteOne({ _id: missing._id });

    const results = await Promise.all(
      targetReports.map((report) =>
        service.getByReportPublicId(report.publicId ?? ''),
      ),
    );

    expect(results.map(({ target }) => target.state)).toEqual([
      AdminPostModerationTargetState.HIDDEN,
      AdminPostModerationTargetState.EXPIRED,
      AdminPostModerationTargetState.DELETED,
      AdminPostModerationTargetState.UNAVAILABLE,
    ]);
    for (const result of results) {
      expect(result.evidence.content).toBe('immutable snapshot evidence');
    }
  });

  it('redacts missing, malformed and off-allowlist media without publicId leak', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post, [
      {
        url: 'https://res.cloudinary.com/betta/image/upload/missing.webp',
        publicId: 'missing-media-public-id',
      },
      { url: 'not-a-url', publicId: 'malformed-media-public-id' },
      {
        url: 'https://evil.test/evidence.webp',
        publicId: 'evil-media-id',
      },
      {
        url: 'https://res.cloudinary.com/betta/raw/upload/evidence.txt',
        publicId: 'wrong-resource-id',
      },
    ]);

    // Mongoose correctly rejects an empty required URL. Bypass application
    // middleware only while arranging this fixture to simulate legacy or
    // externally corrupted evidence that is already missing its media URL.
    await reports.collection.updateOne(
      { _id: report._id },
      { $unset: { 'targetSnapshot.images.0.url': '' } },
    );

    const result = await service.getByReportPublicId(report.publicId ?? '');

    expect(result.evidence.media).toEqual([
      { url: null, redacted: true },
      { url: null, redacted: true },
      { url: null, redacted: true },
      { url: null, redacted: true },
    ]);
    expect(result.evidence.evidenceUnavailable).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/media-public-id|resource-id/u);
  });

  it('keeps targetSnapshot immutable for document and query updates', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post);

    report.targetSnapshot.content = 'document tamper attempt';
    try {
      await report.save();
    } catch (error) {
      expect(String(error)).toContain(
        REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE,
      );
    }

    await expect(
      reports.updateOne(
        { _id: report._id },
        { $set: { 'targetSnapshot.content': 'query tamper attempt' } },
      ),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);
    await expect(
      reports.findOneAndUpdate(
        { _id: report._id },
        { $unset: { targetSnapshot: 1 } },
      ),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    const persisted = await reports.findById(report._id).lean().exec();
    expect(persisted?.targetSnapshot.content).toBe(
      'immutable snapshot evidence',
    );
  });

  it('blocks aggregation pipeline stages that can remove targetSnapshot', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post);

    await expect(
      reports.updateOne({ _id: report._id }, [{ $unset: 'targetSnapshot' }], {
        updatePipeline: true,
      }),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    await expect(
      reports.updateMany(
        { _id: report._id },
        [{ $project: { publicId: 1, status: 1 } }],
        { updatePipeline: true },
      ),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    await expect(
      reports.findOneAndUpdate(
        { _id: report._id },
        [
          {
            $replaceWith: {
              publicId: '$publicId',
              status: '$status',
            },
          },
        ],
        { updatePipeline: true },
      ),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          updateOne: {
            filter: { _id: report._id },
            update: [
              {
                $replaceRoot: {
                  newRoot: {
                    publicId: '$publicId',
                    status: '$status',
                  },
                },
              },
            ],
          },
        },
      ]),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    const persisted = await reports.findById(report._id).lean().exec();
    expect(persisted?.targetSnapshot.content).toBe(
      'immutable snapshot evidence',
    );
    expect(persisted?.targetSnapshot.images).toHaveLength(1);
  });

  it('blocks targetSnapshot mutation through Model.bulkWrite', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post);

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          updateOne: {
            filter: { _id: report._id },
            update: [
              {
                $set: {
                  'targetSnapshot.content': 'bulk pipeline tamper attempt',
                },
              },
            ],
          },
        },
      ]),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          updateMany: {
            filter: { _id: report._id },
            update: {
              $unset: {
                'targetSnapshot.images': 1,
              },
            },
          },
        },
      ]),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          replaceOne: {
            filter: { _id: report._id },
            replacement: {
              publicId: report.publicId,
              targetSnapshot: {
                content: 'bulk replacement tamper attempt',
              },
            },
          },
        },
      ]),
    ).rejects.toThrow(REPORT_TARGET_SNAPSHOT_IMMUTABLE_ERROR_CODE);

    const persisted = await reports.findById(report._id).lean().exec();

    expect(persisted?.targetSnapshot.content).toBe(
      'immutable snapshot evidence',
    );
    expect(persisted?.targetSnapshot.images).toHaveLength(1);
  });

  it('allows safe bulk updates and insertOne with an initial snapshot', async () => {
    const post = await createPost(
      PostModerationState.ACTIVE,
      new Date(Date.now() + 60_000),
    );
    const report = await createReport(post);

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          updateOne: {
            filter: { _id: report._id },
            update: {
              $set: {
                status: ReportStatus.REVIEWING,
              },
            },
          },
        },
      ]),
    ).resolves.toBeDefined();

    const insertedPublicId = generateReportPublicId();
    const insertedReporterId = new Types.ObjectId();

    await expect(
      reports.bulkWrite<Record<string, unknown>>([
        {
          insertOne: {
            document: {
              publicId: insertedPublicId,
              reporterId: insertedReporterId,
              targetType: ReportTargetType.POST,
              targetId: post._id,
              reasonGroup: ReportReasonGroup.VIOLATION_CONTENT,
              reasonDetail: 'bulk insert regression',
              status: ReportStatus.PENDING,
              targetSnapshot: {
                publicId: post.publicId,
                authorUsername: 'bulk_insert_author',
                content: 'initial bulk insert snapshot',
                images: [],
                createdAt: new Date(),
                expireAt: post.expireAt,
              },
            },
          },
        },
      ]),
    ).resolves.toBeDefined();

    const inserted = await reports
      .findOne({ publicId: insertedPublicId })
      .lean()
      .exec();

    expect(inserted?.targetSnapshot).toMatchObject({
      publicId: post.publicId,
      authorUsername: 'bulk_insert_author',
      content: 'initial bulk insert snapshot',
    });
  });

  it('locks the HTTP contract to both permissions', () => {
    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        // Metadata is attached to this handler by the decorator.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        AdminPostModerationDetailController.prototype.getPostDetail,
      ),
    ).toEqual([AdminPermission.REPORTS_VIEW, AdminPermission.POSTS_VIEW]);
  });
});
