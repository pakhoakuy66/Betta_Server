import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { Post } from '../../posts/schemas/post.schema';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import {
  type UploadedImage,
  UploadsService,
} from '../../uploads/services/uploads.service';
import { User } from '../../users/schemas/user.schema';
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
import { ReportRateLimitService } from './report-rate-limit.service';
import { ReportsService } from './reports.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMock = {
  findOne: ModelMethod;
  findOneAndUpdate: ModelMethod;
  updateOne: ModelMethod;
  create: ModelMethod;
};

type SessionMock = {
  startTransaction: Mock<() => void>;
  commitTransaction: Mock<() => Promise<void>>;
  abortTransaction: Mock<() => Promise<void>>;
  inTransaction: Mock<() => boolean>;
  endSession: Mock<() => Promise<void>>;
};

type UploadFileMock = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

const REPORTER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');

const TARGET_USER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');

const POST_ID = new Types.ObjectId('6a4d0e24782427808adea59c');

const REPORT_ID = new Types.ObjectId('6a54d0377730aac9cc174525');

const REPORTER_PUBLIC_ID = 'usr_WG3FwmJfh6';
const TARGET_PUBLIC_ID = 'usr_tXdqiPs9aK';
const POST_PUBLIC_ID = 'post_23456789ABCD';

const NOW = new Date('2026-07-14T10:00:00.000Z');
const POST_CREATED_AT = new Date('2026-07-14T08:00:00.000Z');
const POST_EXPIRE_AT = new Date('2026-07-15T08:00:00.000Z');

const FILES: UploadFileMock[] = [
  {
    buffer: Buffer.from('image'),
    mimetype: 'image/png',
    size: 1024,
    originalname: 'evidence.png',
  },
];

const UPLOADED_IMAGES: UploadedImage[] = [
  {
    url: 'https://example.com/evidence.png',
    publicId: 'betta/system-reports/evidence',
    width: 800,
    height: 600,
    format: 'png',
    bytes: 12345,
  },
];

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error === undefined ? Promise.resolve(value) : Promise.reject(error),
  );

  return query;
};

const createModelMock = (): ModelMock => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  create: jest.fn(),
});

const createSession = (): SessionMock => ({
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(() => Promise.resolve()),
  abortTransaction: jest.fn(() => Promise.resolve()),
  inTransaction: jest.fn(() => true),
  endSession: jest.fn(() => Promise.resolve()),
});

const createReporter = () => ({
  _id: REPORTER_ID,
  publicId: REPORTER_PUBLIC_ID,
  isDeleted: false,
  status: 'active',
});

const createTargetUser = (overrides: Record<string, unknown> = {}) => ({
  _id: TARGET_USER_ID,
  publicId: TARGET_PUBLIC_ID,
  username: 'target_user',
  fullname: 'Target User',
  avatar: 'https://example.com/avatar.jpg',
  bio: 'Target bio',
  status: 'active',
  isDeleted: false,
  ...overrides,
});

const createReportablePost = (overrides: Record<string, unknown> = {}) => ({
  _id: POST_ID,
  publicId: POST_PUBLIC_ID,
  authorId: TARGET_USER_ID,
  content: 'Nội dung bài viết bị báo cáo',
  images: [
    {
      url: 'https://example.com/post.jpg',
      publicId: 'betta/posts/post-image',
    },
  ],
  createdAt: POST_CREATED_AT,
  expireAt: POST_EXPIRE_AT,
  isDeletedByAdmin: false,
  ...overrides,
});

const createReportDocument = (overrides: Record<string, unknown> = {}) => ({
  _id: REPORT_ID,
  status: ReportStatus.PENDING,
  createdAt: NOW,
  ...overrides,
});

const createSystemReportDocument = (
  overrides: Record<string, unknown> = {},
) => ({
  _id: REPORT_ID,
  status: SystemReportStatus.PENDING,
  createdAt: NOW,
  ...overrides,
});

const createContext = () => {
  const models = {
    report: createModelMock(),
    cooldown: createModelMock(),
    post: createModelMock(),
    user: createModelMock(),
    relationship: createModelMock(),
    block: createModelMock(),
    systemReport: createModelMock(),
  };

  const session = createSession();

  const connection = {
    startSession: jest.fn<() => Promise<ClientSession>>(() =>
      Promise.resolve(session as unknown as ClientSession),
    ),
  };

  const uploadsService = {
    uploadSystemReportImages: jest.fn<
      (files: UploadFileMock[]) => Promise<UploadedImage[]>
    >(() => Promise.resolve([])),
    deleteImages: jest.fn<(publicIds: string[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const reportRateLimitService = {
    consumeSystemReport: jest.fn<
      (options: {
        reporterId: Types.ObjectId;
        clientIp?: string;
        descriptionHash: string;
      }) => Promise<void>
    >(() => Promise.resolve()),

    consumeContentReport: jest.fn<
      (options: {
        reporterId: Types.ObjectId;
        clientIp?: string;
        targetType: 'POST' | 'USER';
        targetId: Types.ObjectId;
      }) => Promise<void>
    >(() => Promise.resolve()),
  };

  models.cooldown.findOne.mockReturnValue(createQuery(null));

  models.cooldown.findOneAndUpdate.mockReturnValue(
    createQuery({ _id: new Types.ObjectId() }),
  );

  models.cooldown.updateOne.mockReturnValue(
    createQuery({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    }),
  );

  const service = new ReportsService(
    connection as unknown as Connection,
    models.report as unknown as Model<Report>,
    models.cooldown as unknown as Model<ReportCooldown>,
    models.post as unknown as Model<Post>,
    models.user as unknown as Model<User>,
    models.relationship as unknown as Model<Relationship>,
    models.block as unknown as Model<Block>,
    models.systemReport as unknown as Model<SystemReport>,
    uploadsService as unknown as UploadsService,
    reportRateLimitService as unknown as ReportRateLimitService,
  );

  return {
    service,
    models,
    session,
    connection,
    uploadsService,
    reportRateLimitService,
  };
};

const arrangePostReportAccess = (
  context: ReturnType<typeof createContext>,
  options: {
    post?: ReturnType<typeof createReportablePost>;
    author?: ReturnType<typeof createTargetUser> | null;
    block?: object | null;
    relationship?: object | null;
  } = {},
) => {
  const post = options.post ?? createReportablePost();

  context.models.user.findOne
    .mockReturnValueOnce(createQuery(createReporter()))
    .mockReturnValueOnce(
      createQuery(
        options.author === undefined ? createTargetUser() : options.author,
      ),
    );

  context.models.post.findOne.mockReturnValue(createQuery(post));

  context.models.block.findOne.mockReturnValue(
    createQuery(options.block ?? null),
  );

  context.models.relationship.findOne.mockReturnValue(
    createQuery(
      options.relationship === undefined
        ? { _id: new Types.ObjectId() }
        : options.relationship,
    ),
  );

  return post;
};

const arrangeUserReportAccess = (
  context: ReturnType<typeof createContext>,
  options: {
    target?: ReturnType<typeof createTargetUser>;
    block?: object | null;
  } = {},
) => {
  const target = options.target ?? createTargetUser();

  context.models.user.findOne
    .mockReturnValueOnce(createQuery(createReporter()))
    .mockReturnValueOnce(createQuery(target));

  context.models.block.findOne.mockReturnValue(
    createQuery(options.block ?? null),
  );

  return target;
};

describe('ReportsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('reportIssue', () => {
    it('rejects an invalid reporter id before querying MongoDB', async () => {
      const { service, models, uploadsService } = createContext();

      await expect(
        service.reportIssue('invalid-user', {
          description: 'Không thể sử dụng chức năng thông báo',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(models.user.findOne).not.toHaveBeenCalled();
      expect(uploadsService.uploadSystemReportImages).not.toHaveBeenCalled();
    });

    it('rejects an inactive reporter', async () => {
      const { service, models, reportRateLimitService } = createContext();

      models.user.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.reportIssue(REPORTER_ID.toString(), {
          description: 'Không thể sử dụng chức năng thông báo',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(reportRateLimitService.consumeSystemReport).not.toHaveBeenCalled();
    });

    it('rejects a recent duplicate before rate limit and upload', async () => {
      const { service, models, reportRateLimitService, uploadsService } =
        createContext();

      models.user.findOne.mockReturnValue(createQuery(createReporter()));

      models.systemReport.findOne.mockReturnValue(
        createQuery({ _id: REPORT_ID }),
      );

      await expect(
        service.reportIssue(REPORTER_ID.toString(), {
          description: 'Không thể sử dụng chức năng thông báo',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(reportRateLimitService.consumeSystemReport).not.toHaveBeenCalled();

      expect(uploadsService.uploadSystemReportImages).not.toHaveBeenCalled();
    });

    it('normalizes description and returns only public submission data', async () => {
      const { service, models, uploadsService, reportRateLimitService } =
        createContext();

      models.user.findOne.mockReturnValue(createQuery(createReporter()));

      models.systemReport.findOne.mockReturnValue(createQuery(null));

      uploadsService.uploadSystemReportImages.mockImplementation(() =>
        Promise.resolve(UPLOADED_IMAGES),
      );

      models.systemReport.create.mockImplementation(() =>
        Promise.resolve(createSystemReportDocument()),
      );

      const result = await service.reportIssue(
        REPORTER_ID.toString(),
        {
          description: '  Không thể   sử dụng\nchức năng thông báo  ',
        },
        FILES,
        '203.0.113.10',
      );

      const createInput = models.systemReport.create.mock.calls[0]?.[0];

      expect(createInput).toEqual(
        expect.objectContaining({
          reporterId: REPORTER_ID,
          description: 'Không thể sử dụng chức năng thông báo',
          descriptionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          dedupeKey: expect.stringMatching(
            /^system_issue:[a-f0-9]{24}:[a-f0-9]{64}:\d+$/,
          ),
          evidenceImages: [
            {
              url: 'https://example.com/evidence.png',
              publicId: 'betta/system-reports/evidence',
            },
          ],
        }),
      );

      expect(reportRateLimitService.consumeSystemReport).toHaveBeenCalledWith({
        reporterId: REPORTER_ID,
        clientIp: '203.0.113.10',
        descriptionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      expect(result).toEqual({
        success: true,
        message: 'Đã gửi báo cáo sự cố',
        data: {
          type: 'issue',
          status: 'pending',
          submittedAt: NOW.toISOString(),
        },
      });

      expect(result.data).not.toHaveProperty('_id');
      expect(result.data).not.toHaveProperty('reporterId');
    });

    it('cleans uploaded evidence and maps duplicate key to conflict', async () => {
      const { service, models, uploadsService } = createContext();

      models.user.findOne.mockReturnValue(createQuery(createReporter()));

      models.systemReport.findOne.mockReturnValue(createQuery(null));

      uploadsService.uploadSystemReportImages.mockImplementation(() =>
        Promise.resolve(UPLOADED_IMAGES),
      );

      const duplicateKeyError = Object.assign(
        new Error('Duplicate system report'),
        { code: 11000 },
      );

      models.systemReport.create.mockImplementation(() =>
        Promise.reject(duplicateKeyError),
      );

      await expect(
        service.reportIssue(
          REPORTER_ID.toString(),
          {
            description: 'Không thể sử dụng chức năng thông báo',
          },
          FILES,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(uploadsService.deleteImages).toHaveBeenCalledWith([
        'betta/system-reports/evidence',
      ]);
    });
  });

  describe('reportPost', () => {
    it('rejects an invalid public post id without querying MongoDB', async () => {
      const { service, models } = createContext();

      await expect(
        service.reportPost(REPORTER_ID.toString(), 'invalid-post', {
          reasonDetail: 'Nội dung vi phạm',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.user.findOne).not.toHaveBeenCalled();
      expect(models.post.findOne).not.toHaveBeenCalled();
    });

    it('rejects reporting the reporter own post', async () => {
      const context = createContext();

      context.models.user.findOne.mockReturnValue(
        createQuery(createReporter()),
      );

      context.models.post.findOne.mockReturnValue(
        createQuery(
          createReportablePost({
            authorId: REPORTER_ID,
          }),
        ),
      );

      await expect(
        context.service.reportPost(REPORTER_ID.toString(), POST_PUBLIC_ID, {
          reasonDetail: 'Nội dung vi phạm',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(context.models.block.findOne).not.toHaveBeenCalled();
      expect(context.models.report.create).not.toHaveBeenCalled();
    });

    it('hides the post when either user has blocked the other', async () => {
      const context = createContext();

      arrangePostReportAccess(context, {
        block: { _id: new Types.ObjectId() },
      });

      await expect(
        context.service.reportPost(REPORTER_ID.toString(), POST_PUBLIC_ID, {
          reasonDetail: 'Nội dung vi phạm',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(
        context.reportRateLimitService.consumeContentReport,
      ).not.toHaveBeenCalled();
    });

    it('requires following the post author', async () => {
      const context = createContext();

      arrangePostReportAccess(context, {
        relationship: null,
      });

      await expect(
        context.service.reportPost(REPORTER_ID.toString(), POST_PUBLIC_ID, {
          reasonDetail: 'Nội dung vi phạm',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(context.models.report.create).not.toHaveBeenCalled();
    });

    it('rejects an active cooldown before consuming rate limit', async () => {
      const context = createContext();

      arrangePostReportAccess(context);

      context.models.cooldown.findOne.mockReturnValue(
        createQuery({ _id: new Types.ObjectId() }),
      );

      await expect(
        context.service.reportPost(REPORTER_ID.toString(), POST_PUBLIC_ID, {
          reasonDetail: 'Nội dung vi phạm',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(
        context.reportRateLimitService.consumeContentReport,
      ).not.toHaveBeenCalled();

      expect(context.connection.startSession).not.toHaveBeenCalled();
    });

    it('creates a transactional report with an immutable target snapshot', async () => {
      const context = createContext();
      const post = arrangePostReportAccess(context);

      context.models.report.create.mockImplementation(() =>
        Promise.resolve([createReportDocument()]),
      );

      const result = await context.service.reportPost(
        REPORTER_ID.toString(),
        POST_PUBLIC_ID,
        {
          reasonGroup: ReportReasonGroup.INAPPROPRIATE_CONTENT,
          reasonDetail: 'Nội dung không phù hợp',
          description: 'Mô tả bổ sung',
        },
        '203.0.113.10',
      );

      expect(
        context.reportRateLimitService.consumeContentReport,
      ).toHaveBeenCalledWith({
        reporterId: REPORTER_ID,
        clientIp: '203.0.113.10',
        targetType: ReportTargetType.POST,
        targetId: POST_ID,
      });

      expect(context.models.report.create).toHaveBeenCalledWith(
        [
          {
            reporterId: REPORTER_ID,
            targetType: ReportTargetType.POST,
            targetId: POST_ID,
            reasonGroup: ReportReasonGroup.INAPPROPRIATE_CONTENT,
            reasonDetail: 'Nội dung không phù hợp',
            description: 'Mô tả bổ sung',
            targetSnapshot: {
              publicId: POST_PUBLIC_ID,
              authorId: TARGET_USER_ID,
              authorUsername: 'target_user',
              content: post.content,
              images: [
                {
                  url: 'https://example.com/post.jpg',
                  publicId: 'betta/posts/post-image',
                },
              ],
              createdAt: POST_CREATED_AT,
              expireAt: POST_EXPIRE_AT,
            },
          },
        ],
        {
          session: context.session,
        },
      );

      expect(context.session.startTransaction).toHaveBeenCalledTimes(1);
      expect(context.session.commitTransaction).toHaveBeenCalledTimes(1);
      expect(context.session.abortTransaction).not.toHaveBeenCalled();
      expect(context.session.endSession).toHaveBeenCalledTimes(1);

      expect(result).toEqual({
        success: true,
        message: 'Đã gửi báo cáo bài viết',
        data: {
          type: 'post',
          status: 'pending',
          submittedAt: NOW.toISOString(),
        },
      });

      expect(result.data).not.toHaveProperty('_id');
      expect(result.data).not.toHaveProperty('targetId');
    });
  });

  describe('reportUser', () => {
    it('rejects an invalid user public id without querying MongoDB', async () => {
      const { service, models } = createContext();

      await expect(
        service.reportUser(REPORTER_ID.toString(), 'invalid-user', {
          reasonDetail: 'Tài khoản giả mạo',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('rejects reporting the current account', async () => {
      const context = createContext();

      context.models.user.findOne
        .mockReturnValueOnce(createQuery(createReporter()))
        .mockReturnValueOnce(
          createQuery(
            createTargetUser({
              _id: REPORTER_ID,
              publicId: REPORTER_PUBLIC_ID,
            }),
          ),
        );

      await expect(
        context.service.reportUser(REPORTER_ID.toString(), REPORTER_PUBLIC_ID, {
          reasonDetail: 'Tài khoản giả mạo',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(context.models.block.findOne).not.toHaveBeenCalled();
    });

    it('hides a blocked target account', async () => {
      const context = createContext();

      arrangeUserReportAccess(context, {
        block: { _id: new Types.ObjectId() },
      });

      await expect(
        context.service.reportUser(REPORTER_ID.toString(), TARGET_PUBLIC_ID, {
          reasonDetail: 'Tài khoản giả mạo',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(
        context.reportRateLimitService.consumeContentReport,
      ).not.toHaveBeenCalled();
    });

    it('creates a user report with a target snapshot', async () => {
      const context = createContext();

      arrangeUserReportAccess(context);

      context.models.report.create.mockImplementation(() =>
        Promise.resolve([createReportDocument()]),
      );

      const result = await context.service.reportUser(
        REPORTER_ID.toString(),
        TARGET_PUBLIC_ID,
        {
          reasonGroup: ReportReasonGroup.IMPERSONATION,
          reasonDetail: 'Tài khoản giả mạo',
          description: 'Dùng tên và ảnh của người khác',
        },
        '203.0.113.10',
      );

      expect(context.models.report.create).toHaveBeenCalledWith(
        [
          {
            reporterId: REPORTER_ID,
            targetType: ReportTargetType.USER,
            targetId: TARGET_USER_ID,
            reasonGroup: ReportReasonGroup.IMPERSONATION,
            reasonDetail: 'Tài khoản giả mạo',
            description: 'Dùng tên và ảnh của người khác',
            targetSnapshot: {
              publicId: TARGET_PUBLIC_ID,
              username: 'target_user',
              fullname: 'Target User',
              avatar: 'https://example.com/avatar.jpg',
              bio: 'Target bio',
              targetStatus: 'active',
            },
          },
        ],
        {
          session: context.session,
        },
      );

      expect(context.models.cooldown.updateOne).toHaveBeenCalledWith(
        {
          reporterId: REPORTER_ID,
          targetType: ReportTargetType.USER,
          targetId: TARGET_USER_ID,
        },
        {
          $set: {
            lastReportId: REPORT_ID,
          },
        },
        {
          session: context.session,
        },
      );

      expect(result.data).toEqual({
        type: 'user',
        status: 'pending',
        submittedAt: NOW.toISOString(),
      });
    });

    it('retries a transient MongoDB transaction error', async () => {
      const context = createContext();

      arrangeUserReportAccess(context);

      const transientError = Object.assign(
        new Error('Transient transaction error'),
        {
          errorLabels: ['TransientTransactionError'],
        },
      );

      context.models.report.create
        .mockImplementationOnce(() => Promise.reject(transientError))
        .mockImplementationOnce(() =>
          Promise.resolve([createReportDocument()]),
        );

      const result = await context.service.reportUser(
        REPORTER_ID.toString(),
        TARGET_PUBLIC_ID,
        {
          reasonDetail: 'Tài khoản giả mạo',
        },
      );

      expect(context.connection.startSession).toHaveBeenCalledTimes(2);
      expect(context.session.startTransaction).toHaveBeenCalledTimes(2);
      expect(context.session.abortTransaction).toHaveBeenCalledTimes(1);
      expect(context.session.commitTransaction).toHaveBeenCalledTimes(1);
      expect(context.session.endSession).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });
  });
});
