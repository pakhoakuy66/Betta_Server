import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model, Types, type AnyBulkWriteOperation } from 'mongoose';
import { AppModule } from '../app.module';
import { Post } from '../modules/posts/schemas/post.schema';
import {
  EngagementEvent,
  EngagementEventType,
} from '../modules/recap/schemas/engagement-event.schema';
import {
  getRecapWeekRange,
  RECAP_TIMEZONE,
} from '../modules/recap/utils/recap-week.util';

const BATCH_SIZE = 500;

type PostBackfillRow = {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  publicId: string;
  createdAt: Date;
};

const findPostBatch = async (
  postModel: Model<Post>,
  lastId: Types.ObjectId | null,
): Promise<PostBackfillRow[]> => {
  const query = lastId
    ? postModel.find({ _id: { $gt: lastId } })
    : postModel.find();

  return query
    .select('_id authorId publicId createdAt')
    .sort({ _id: 1 })
    .limit(BATCH_SIZE)
    .lean<PostBackfillRow[]>()
    .exec();
};

const bootstrap = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());

    console.log(
      `[BackfillPostCreatedEvents] database=${
        connection.db?.databaseName ?? 'unknown'
      }`,
    );

    const postModel = app.get<Model<Post>>(getModelToken(Post.name));
    const engagementEventModel = app.get<Model<EngagementEvent>>(
      getModelToken(EngagementEvent.name),
    );

    let scanned = 0;
    let upserted = 0;
    let lastId: Types.ObjectId | null = null;

    while (true) {
      const posts = await findPostBatch(postModel, lastId);

      if (posts.length === 0) break;

      scanned += posts.length;
      lastId = posts[posts.length - 1]._id;

      const operations: AnyBulkWriteOperation<EngagementEvent>[] = posts.map(
        (post) => {
          const occurredAt = post.createdAt;
          const { weekStart, weekEnd } = getRecapWeekRange(occurredAt);
          const eventKey = [
            EngagementEventType.POST_CREATED,
            post._id.toString(),
          ].join(':');

          return {
            updateOne: {
              filter: { eventKey },
              update: {
                $setOnInsert: {
                  eventKey,
                  type: EngagementEventType.POST_CREATED,
                  actorId: post.authorId,
                  postOwnerId: post.authorId,
                  postId: post._id,
                  postPublicId: post.publicId,
                  occurredAt,
                  weekStart,
                  weekEnd,
                  timezone: RECAP_TIMEZONE,
                },
              },
              upsert: true,
            },
          };
        },
      );

      const result = await engagementEventModel.bulkWrite(operations, {
        ordered: false,
      });

      upserted += result.upsertedCount;
    }

    console.log(
      `[BackfillPostCreatedEvents] scanned=${scanned}, upserted=${upserted}`,
    );
  } finally {
    await app.close();
  }
};

void bootstrap();
