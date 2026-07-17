import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { PostShare } from '../../posts/schemas/post-share.schema';
import { Post } from '../../posts/schemas/post.schema';
import { Reaction } from '../../reactions/schemas/reaction.schema';
import { EngagementEvent } from '../../recap/schemas/engagement-event.schema';
import { WeeklyRecap } from '../../recap/schemas/recap.schema';
import { Notification } from '../../notifications/schemas/notifications.schema';
import { ReportCooldown } from '../../reports/schemas/report-cooldown.schema';
import { StreakHistory } from '../../streak/schemas/streak.schema';
import {
  UploadsService,
  type UploadedImage,
} from '../../uploads/services/uploads.service';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  User,
} from '../schemas/user.schema';
import { UsersService } from './users.service';

type UploadFileMock = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

export type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  sort: Mock<(sort: unknown) => QueryMock<T>>;
  collation: Mock<(collation: unknown) => QueryMock<T>>;
  skip: Mock<(amount: number) => QueryMock<T>>;
  limit: Mock<(amount: number) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  session: Mock<(session: unknown) => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

export type ModelMock = {
  find: ModelMethod;
  findOne: ModelMethod;
  findOneAndUpdate: ModelMethod;
  findById: ModelMethod;
  updateOne: ModelMethod;
  updateMany: ModelMethod;
  deleteMany: ModelMethod;
  aggregate: ModelMethod;
};

export const CURRENT_USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
export const TARGET_USER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');
export const BLOCKED_USER_ID = new Types.ObjectId('6a4d0b24782427808adea4d5');

export const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.collation = jest.fn(() => query);
  query.skip = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.session = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error === undefined ? Promise.resolve(value) : Promise.reject(error),
  );

  return query;
};

const createModelMock = (): ModelMock => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
  aggregate: jest.fn(),
});

export const createUserSource = (overrides: Record<string, unknown> = {}) => ({
  _id: TARGET_USER_ID,
  publicId: 'usr_tXdqiPs9aK',
  username: 'target_user',
  fullname: 'Target User',
  email: 'target@example.com',
  phone: '0900000000',
  password: 'stored-password-hash',
  avatar: DEFAULT_AVATAR_URL,
  avatarId: DEFAULT_AVATAR_ID,
  bio: '',
  link: '',
  streakCount: 3,
  postsCount: 2,
  followersCount: 0,
  followingCount: 0,
  status: 'active',
  isDeleted: false,
  notificationSettings: {
    enabled: true,
    follow: true,
    reaction: true,
    recap: true,
  },
  save: jest.fn(() => Promise.resolve()),
  ...overrides,
});

export const createUsersServiceContext = () => {
  const models = {
    user: createModelMock(),
    relationship: createModelMock(),
    block: createModelMock(),
    post: createModelMock(),
    reaction: createModelMock(),
    postShare: createModelMock(),
    notification: createModelMock(),
    engagementEvent: createModelMock(),
    weeklyRecap: createModelMock(),
    streakHistory: createModelMock(),
    reportCooldown: createModelMock(),
  };

  const connection = {
    startSession: jest.fn(),
  };

  const uploadsService = {
    uploadAvatar: jest.fn<(file: UploadFileMock) => Promise<UploadedImage>>(),
    deleteImage: jest.fn<(publicId: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    deleteImages: jest.fn<(publicIds: string[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const service = new UsersService(
    connection as unknown as Connection,
    models.user as unknown as Model<User>,
    models.relationship as unknown as Model<Relationship>,
    models.block as unknown as Model<Block>,
    models.post as unknown as Model<Post>,
    models.reaction as unknown as Model<Reaction>,
    models.postShare as unknown as Model<PostShare>,
    models.notification as unknown as Model<Notification>,
    models.engagementEvent as unknown as Model<EngagementEvent>,
    models.weeklyRecap as unknown as Model<WeeklyRecap>,
    models.streakHistory as unknown as Model<StreakHistory>,
    models.reportCooldown as unknown as Model<ReportCooldown>,
    uploadsService as unknown as UploadsService,
  );

  return {
    service,
    models,
    connection,
    uploadsService,
  };
};
