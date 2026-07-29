import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { Post } from '../../posts/schemas/post.schema';
import { RecapService } from '../../recap/services/recap.service';
import { Block } from '../../relationshipModule/schemas/block.schema';
import { Relationship } from '../../relationshipModule/schemas/relationship.schema';
import { User } from '../../users/schemas/user.schema';
import { Reaction, ReactionType } from '../schemas/reaction.schema';
import { ReactionService } from './reaction.service';

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  session: Mock<(session: ClientSession) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMock = {
  findOne: ModelMethod;
  findOneAndDelete: ModelMethod;
  findOneAndUpdate: ModelMethod;
  updateOne: ModelMethod;
};

type ReactionNotificationInput = {
  actorId: Types.ObjectId;
  postOwnerId: Types.ObjectId;
  postId: Types.ObjectId;
  postPublicId: string;
};

const CURRENT_USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const POST_OWNER_ID = new Types.ObjectId('6a3273479cdfc0a0d31bcd6f');
const POST_ID = new Types.ObjectId('6a4d0e24782427808adea59c');
const POST_PUBLIC_ID = 'post_23456789ABCD';

const createQuery = <T>(value: T, error?: Error): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.session = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() =>
    error ? Promise.reject(error) : Promise.resolve(value),
  );

  return query;
};

const createModelMock = (): ModelMock => ({
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
});

const createContext = () => {
  const models = {
    reaction: createModelMock(),
    post: createModelMock(),
    user: createModelMock(),
    relationship: createModelMock(),
    block: createModelMock(),
  };

  const session = {
    withTransaction: jest.fn((operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: jest.fn(() => Promise.resolve()),
  };

  const connection = {
    startSession: jest.fn(() => Promise.resolve(session)),
  };

  const notificationsService = {
    createReactionNotification: jest.fn<
      (input: ReactionNotificationInput) => Promise<void>
    >(() => Promise.resolve()),
  };

  const recapService = {
    recordReactionCreatedEvent: jest.fn<
      (input: ReactionNotificationInput) => Promise<void>
    >(() => Promise.resolve()),
  };

  const service = new ReactionService(
    connection as unknown as Connection,
    models.reaction as unknown as Model<Reaction>,
    models.post as unknown as Model<Post>,
    models.user as unknown as Model<User>,
    models.relationship as unknown as Model<Relationship>,
    models.block as unknown as Model<Block>,
    notificationsService as unknown as NotificationsService,
    recapService as unknown as RecapService,
  );

  return {
    service,
    models,
    session,
    connection,
    notificationsService,
    recapService,
  };
};

const configureReactablePost = (
  context: ReturnType<typeof createContext>,
  {
    blockRecord = null,
    relationship = { _id: new Types.ObjectId() },
  }: {
    blockRecord?: unknown;
    relationship?: unknown;
  } = {},
) => {
  const { models } = context;

  models.user.findOne
    .mockReturnValueOnce(createQuery({ _id: CURRENT_USER_ID }))
    .mockReturnValueOnce(createQuery({ _id: POST_OWNER_ID }));

  models.post.findOne
    .mockReturnValueOnce(
      createQuery({
        _id: POST_ID,
        publicId: POST_PUBLIC_ID,
        authorId: POST_OWNER_ID,
        likeCount: 3,
      }),
    )
    .mockReturnValueOnce(createQuery({ _id: POST_ID }));

  models.block.findOne.mockReturnValue(createQuery(blockRecord));
  models.relationship.findOne.mockReturnValue(createQuery(relationship));
};

describe('ReactionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates one reaction atomically and emits side effects after commit', async () => {
    const context = createContext();
    const { service, models, session, notificationsService, recapService } =
      context;

    configureReactablePost(context);

    models.reaction.updateOne.mockReturnValue(
      createQuery({ upsertedCount: 1 }),
    );
    models.post.findOneAndUpdate.mockReturnValue(createQuery({ likeCount: 4 }));

    await expect(
      service.reactToPost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID, {
        emojiType: ReactionType.HEART,
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Đã thả tim bài viết',
      data: {
        reacted: true,
        emojiType: ReactionType.HEART,
        likeCount: 4,
      },
    });

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(models.reaction.updateOne).toHaveBeenCalledWith(
      {
        userId: CURRENT_USER_ID,
        postId: POST_ID,
      },
      {
        $set: {
          emojiType: ReactionType.HEART,
        },
        $setOnInsert: {
          userId: CURRENT_USER_ID,
          postId: POST_ID,
          postOwnerId: POST_OWNER_ID,
        },
      },
      {
        upsert: true,
        session,
      },
    );
    expect(models.post.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: POST_ID,
        isDeletedByAdmin: false,
      }),
      { $inc: { likeCount: 1 } },
      expect.objectContaining({
        session,
        projection: { likeCount: 1 },
      }),
    );
    expect(
      notificationsService.createReactionNotification,
    ).toHaveBeenCalledWith({
      actorId: CURRENT_USER_ID,
      postOwnerId: POST_OWNER_ID,
      postId: POST_ID,
      postPublicId: POST_PUBLIC_ID,
    });
    expect(recapService.recordReactionCreatedEvent).toHaveBeenCalledWith({
      actorId: CURRENT_USER_ID,
      postOwnerId: POST_OWNER_ID,
      postId: POST_ID,
      postPublicId: POST_PUBLIC_ID,
    });
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('updates an existing reaction without incrementing or duplicating side effects', async () => {
    const context = createContext();
    const { service, models, notificationsService, recapService } = context;

    configureReactablePost(context);

    models.reaction.updateOne.mockReturnValue(
      createQuery({ upsertedCount: 0 }),
    );
    models.post.findOne.mockReturnValueOnce(createQuery({ likeCount: 3 }));

    await expect(
      service.reactToPost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID, {
        emojiType: ReactionType.HEART,
      }),
    ).resolves.toMatchObject({
      data: {
        reacted: true,
        likeCount: 3,
      },
    });

    expect(models.post.findOneAndUpdate).not.toHaveBeenCalled();
    expect(
      notificationsService.createReactionNotification,
    ).not.toHaveBeenCalled();
    expect(recapService.recordReactionCreatedEvent).not.toHaveBeenCalled();
  });

  it('removes an existing reaction and decrements the count once', async () => {
    const context = createContext();
    const { service, models, session } = context;

    configureReactablePost(context);

    models.reaction.findOneAndDelete.mockReturnValue(
      createQuery({ _id: new Types.ObjectId() }),
    );
    models.post.findOneAndUpdate.mockReturnValue(createQuery({ likeCount: 2 }));

    await expect(
      service.removeReaction(CURRENT_USER_ID.toString(), POST_PUBLIC_ID),
    ).resolves.toEqual({
      success: true,
      message: 'Đã hủy reaction bài viết',
      data: {
        reacted: false,
        emojiType: null,
        likeCount: 2,
      },
    });

    expect(models.reaction.findOneAndDelete).toHaveBeenCalledWith({
      userId: CURRENT_USER_ID,
      postId: POST_ID,
    });
    expect(models.post.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: POST_ID,
        likeCount: { $gt: 0 },
      }),
      { $inc: { likeCount: -1 } },
      expect.objectContaining({ session }),
    );
  });

  it('returns an idempotent remove result when no reaction exists', async () => {
    const context = createContext();
    const { service, models } = context;

    configureReactablePost(context);

    models.reaction.findOneAndDelete.mockReturnValue(createQuery(null));
    models.post.findOne.mockReturnValueOnce(createQuery({ likeCount: 3 }));

    await expect(
      service.removeReaction(CURRENT_USER_ID.toString(), POST_PUBLIC_ID),
    ).resolves.toMatchObject({
      data: {
        reacted: false,
        likeCount: 3,
      },
    });

    expect(models.post.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a blocked pair before opening a transaction', async () => {
    const context = createContext();
    const { service, connection } = context;

    configureReactablePost(context, {
      blockRecord: { _id: new Types.ObjectId() },
    });

    await expect(
      service.reactToPost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID, {
        emojiType: ReactionType.HEART,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(connection.startSession).not.toHaveBeenCalled();
  });

  it('requires a follow relationship for a non-owner post', async () => {
    const context = createContext();
    const { service, connection } = context;

    configureReactablePost(context, {
      relationship: null,
    });

    await expect(
      service.reactToPost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID, {
        emojiType: ReactionType.HEART,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(connection.startSession).not.toHaveBeenCalled();
  });

  it('rolls back when the post expires after the preflight check', async () => {
    const context = createContext();
    const { service, models, session } = context;

    configureReactablePost(context);
    models.post.findOne.mockReset();
    models.post.findOne
      .mockReturnValueOnce(
        createQuery({
          _id: POST_ID,
          publicId: POST_PUBLIC_ID,
          authorId: POST_OWNER_ID,
          likeCount: 3,
        }),
      )
      .mockReturnValueOnce(createQuery(null));

    await expect(
      service.reactToPost(CURRENT_USER_ID.toString(), POST_PUBLIC_ID, {
        emojiType: ReactionType.HEART,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(models.reaction.updateOne).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});
