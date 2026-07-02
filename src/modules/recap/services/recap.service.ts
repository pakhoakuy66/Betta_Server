import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type PipelineStage } from 'mongoose';
import {
  EngagementEvent,
  EngagementEventType,
} from '../schemas/engagement-event.schema';
import { WeeklyRecap } from '../schemas/recap.schema';
import { User } from '../../users/schemas/user.schema';
import {
  getRecapWeekIdentity,
  getRecapWeekKey,
  getRecapWeekRange,
  RECAP_TIMEZONE,
} from '../utils/recap-week.util';

const TOP_INTERACTION_LIMIT = 5;
const TOP_INTERACTION_CANDIDATE_LIMIT = 20;
const BULK_WRITE_CHUNK_SIZE = 500;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type RecordPostCreatedEventPayload = {
  actorId: Types.ObjectId;
  postId: Types.ObjectId;
  postPublicId: string;
  occurredAt?: Date;
};

type RecordReactionCreatedEventPayload = {
  actorId: Types.ObjectId;
  postOwnerId: Types.ObjectId;
  postId: Types.ObjectId;
  postPublicId: string;
  occurredAt?: Date;
};

type MongoDuplicateKeyError = {
  code?: number;
};

type AggregateWeeklyRecapOptions = {
  referenceDate?: Date;
  weekStart?: Date;
};

type CountByUserRow = {
  _id: Types.ObjectId;
  count: number;
};

type TopUsersRow = {
  _id: Types.ObjectId;
  users: Types.ObjectId[];
};

type WeeklyRecapStats = {
  postsCount: number;
  heartsGave: number;
  heartsReceived: number;
  topGivers: Types.ObjectId[];
  topReceivers: Types.ObjectId[];
};

type WeeklyReactionStats = {
  heartsReceivedMap: Map<string, number>;
  heartsGaveMap: Map<string, number>;
  topGiversMap: Map<string, Types.ObjectId[]>;
  topReceiversMap: Map<string, Types.ObjectId[]>;
};

type WeeklyReactionStatsFacetRow = {
  heartsReceived: CountByUserRow[];
  heartsGave: CountByUserRow[];
  topGivers: TopUsersRow[];
  topReceivers: TopUsersRow[];
};

@Injectable()
export class RecapService {
  private readonly logger = new Logger(RecapService.name);

  constructor(
    @InjectModel(EngagementEvent.name)
    private readonly engagementEventModel: Model<EngagementEvent>,

    @InjectModel(WeeklyRecap.name)
    private readonly weeklyRecapModel: Model<WeeklyRecap>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async recordPostCreatedEvent({
    actorId,
    postId,
    postPublicId,
    occurredAt = new Date(),
  }: RecordPostCreatedEventPayload): Promise<void> {
    const { weekStart, weekEnd } = getRecapWeekRange(occurredAt);
    const eventKey = [EngagementEventType.POST_CREATED, postId.toString()].join(
      ':',
    );

    try {
      await this.engagementEventModel.create({
        eventKey,
        type: EngagementEventType.POST_CREATED,
        actorId,
        postOwnerId: actorId,
        postId,
        postPublicId,
        occurredAt,
        weekStart,
        weekEnd,
        timezone: RECAP_TIMEZONE,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) return;

      this.logger.warn(
        `Failed to record post engagement event. actor=${actorId.toString()}, post=${postPublicId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async recordReactionCreatedEvent({
    actorId,
    postOwnerId,
    postId,
    postPublicId,
    occurredAt = new Date(),
  }: RecordReactionCreatedEventPayload): Promise<void> {
    const { weekStart, weekEnd } = getRecapWeekRange(occurredAt);
    const eventKey = this.buildReactionEventKey({
      actorId,
      postId,
      weekStart,
    });

    try {
      await this.engagementEventModel.create({
        eventKey,
        type: EngagementEventType.REACTION_CREATED,
        actorId,
        postOwnerId,
        postId,
        postPublicId,
        occurredAt,
        weekStart,
        weekEnd,
        timezone: RECAP_TIMEZONE,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) return;

      this.logger.warn(
        `Failed to record reaction engagement event. actor=${actorId.toString()}, post=${postPublicId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async aggregateWeeklyRecap({
    referenceDate,
    weekStart,
  }: AggregateWeeklyRecapOptions = {}) {
    const range = weekStart
      ? {
          weekStart,
          weekEnd: new Date(weekStart.getTime() + ONE_WEEK_MS),
        }
      : getRecapWeekRange(referenceDate ?? new Date());

    const weekIdentity = getRecapWeekIdentity(range.weekStart);

    const [postsCountMap, reactionStats] = await Promise.all([
      this.getPostsCountMap(range.weekStart, range.weekEnd),
      this.getWeeklyReactionStats(range.weekStart, range.weekEnd),
    ]);

    const { heartsReceivedMap, heartsGaveMap, topGiversMap, topReceiversMap } =
      reactionStats;

    const activityUserIds = this.collectActivityUserIds([
      postsCountMap,
      heartsReceivedMap,
      heartsGaveMap,
      topGiversMap,
      topReceiversMap,
    ]);

    const activeUserIds = await this.filterActiveUserIds(activityUserIds);
    const activeUserIdSet = new Set(activeUserIds);

    if (activeUserIds.length === 0) {
      return {
        success: true,
        data: {
          weekStart: range.weekStart,
          weekEnd: range.weekEnd,
          timezone: RECAP_TIMEZONE,
          processed: 0,
          upserted: 0,
          modified: 0,
          matched: 0,
        },
      };
    }

    const operations = activeUserIds.map((userId) => {
      const stats: WeeklyRecapStats = {
        postsCount: postsCountMap.get(userId) ?? 0,
        heartsReceived: heartsReceivedMap.get(userId) ?? 0,
        heartsGave: heartsGaveMap.get(userId) ?? 0,
        topGivers: this.filterActiveTopUsers(
          topGiversMap.get(userId) ?? [],
          activeUserIdSet,
        ),
        topReceivers: this.filterActiveTopUsers(
          topReceiversMap.get(userId) ?? [],
          activeUserIdSet,
        ),
      };

      return {
        updateOne: {
          filter: {
            userId: new Types.ObjectId(userId),
            weekKey: weekIdentity.weekKey,
            timezone: RECAP_TIMEZONE,
          },
          update: {
            $set: {
              userId: new Types.ObjectId(userId),
              year: weekIdentity.year,
              weekNumber: weekIdentity.weekNumber,
              weekKey: weekIdentity.weekKey,
              weekStart: range.weekStart,
              weekEnd: range.weekEnd,
              timezone: RECAP_TIMEZONE,
              stats,
            },
            $setOnInsert: {
              isSeen: false,
            },
          },
          upsert: true,
        },
      };
    });

    const writeResult = await this.bulkWriteInChunks(operations);

    return {
      success: true,
      data: {
        weekStart: range.weekStart,
        weekEnd: range.weekEnd,
        timezone: RECAP_TIMEZONE,
        processed: activeUserIds.length,
        upserted: writeResult.upserted,
        modified: writeResult.modified,
        matched: writeResult.matched,
      },
    };
  }

  private async getPostsCountMap(
    weekStart: Date,
    weekEnd: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.engagementEventModel
      .aggregate<CountByUserRow>([
        {
          $match: {
            type: EngagementEventType.POST_CREATED,
            occurredAt: { $gte: weekStart, $lt: weekEnd },
          },
        },
        {
          $group: {
            _id: '$actorId',
            count: { $sum: 1 },
          },
        },
      ])
      .exec();

    return this.toCountMap(rows);
  }

  private async getWeeklyReactionStats(
    weekStart: Date,
    weekEnd: Date,
  ): Promise<WeeklyReactionStats> {
    const rows = await this.engagementEventModel
      .aggregate<WeeklyReactionStatsFacetRow>([
        ...this.buildWeeklyReactionBasePipeline(weekStart, weekEnd),
        {
          $facet: {
            heartsReceived: [
              {
                $group: {
                  _id: '$postOwnerId',
                  count: { $sum: 1 },
                },
              },
            ],
            heartsGave: [
              {
                $group: {
                  _id: '$actorId',
                  count: { $sum: 1 },
                },
              },
            ],
            topGivers: [
              {
                $group: {
                  _id: {
                    userId: '$postOwnerId',
                    actorId: '$actorId',
                  },
                  count: { $sum: 1 },
                },
              },
              {
                $sort: {
                  '_id.userId': 1,
                  count: -1,
                  '_id.actorId': 1,
                },
              },
              {
                $group: {
                  _id: '$_id.userId',
                  users: { $push: '$_id.actorId' },
                },
              },
              {
                $project: {
                  users: {
                    $slice: ['$users', TOP_INTERACTION_CANDIDATE_LIMIT],
                  },
                },
              },
            ],
            topReceivers: [
              {
                $group: {
                  _id: {
                    userId: '$actorId',
                    receiverId: '$postOwnerId',
                  },
                  count: { $sum: 1 },
                },
              },
              {
                $sort: {
                  '_id.userId': 1,
                  count: -1,
                  '_id.receiverId': 1,
                },
              },
              {
                $group: {
                  _id: '$_id.userId',
                  users: { $push: '$_id.receiverId' },
                },
              },
              {
                $project: {
                  users: {
                    $slice: ['$users', TOP_INTERACTION_CANDIDATE_LIMIT],
                  },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const result = rows[0];

    return {
      heartsReceivedMap: this.toCountMap(result?.heartsReceived ?? []),
      heartsGaveMap: this.toCountMap(result?.heartsGave ?? []),
      topGiversMap: this.toUsersMap(result?.topGivers ?? []),
      topReceiversMap: this.toUsersMap(result?.topReceivers ?? []),
    };
  }

  private buildWeeklyReactionBasePipeline(
    weekStart: Date,
    weekEnd: Date,
  ): PipelineStage[] {
    return [
      {
        $match: {
          type: EngagementEventType.REACTION_CREATED,
          occurredAt: { $gte: weekStart, $lt: weekEnd },
          $expr: { $ne: ['$actorId', '$postOwnerId'] },
        },
      },
      {
        $lookup: {
          from: 'engagement_events',
          let: {
            reactionPostId: '$postId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$type', EngagementEventType.POST_CREATED] },
                    { $eq: ['$postId', '$$reactionPostId'] },
                    { $eq: ['$weekStart', weekStart] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 1,
              },
            },
          ],
          as: 'weeklyPost',
        },
      },
      {
        $match: {
          weeklyPost: { $ne: [] },
        },
      },
    ];
  }

  private collectActivityUserIds(maps: Array<Map<string, unknown>>): string[] {
    const userIds = new Set<string>();

    for (const map of maps) {
      for (const userId of map.keys()) {
        userIds.add(userId);
      }
    }

    return [...userIds];
  }

  private async filterActiveUserIds(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];

    const users = await this.userModel
      .find({
        _id: { $in: userIds.map((id) => new Types.ObjectId(id)) },
        isDeleted: false,
        status: 'active',
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();

    return users.map((user) => user._id.toString());
  }

  private async bulkWriteInChunks(
    operations: Parameters<Model<WeeklyRecap>['bulkWrite']>[0],
  ): Promise<{ upserted: number; modified: number; matched: number }> {
    let upserted = 0;
    let modified = 0;
    let matched = 0;

    for (
      let index = 0;
      index < operations.length;
      index += BULK_WRITE_CHUNK_SIZE
    ) {
      const chunk = operations.slice(index, index + BULK_WRITE_CHUNK_SIZE);

      const result = await this.weeklyRecapModel.bulkWrite(chunk, {
        ordered: false,
      });

      upserted += result.upsertedCount;
      modified += result.modifiedCount;
      matched += result.matchedCount;
    }

    return { upserted, modified, matched };
  }

  private toCountMap(rows: CountByUserRow[]): Map<string, number> {
    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  }

  private toUsersMap(rows: TopUsersRow[]): Map<string, Types.ObjectId[]> {
    return new Map(rows.map((row) => [row._id.toString(), row.users]));
  }

  private filterActiveTopUsers(
    userIds: Types.ObjectId[],
    activeUserIdSet: Set<string>,
  ): Types.ObjectId[] {
    return userIds
      .filter((userId) => activeUserIdSet.has(userId.toString()))
      .slice(0, TOP_INTERACTION_LIMIT);
  }

  private buildReactionEventKey({
    actorId,
    postId,
    weekStart,
  }: {
    actorId: Types.ObjectId;
    postId: Types.ObjectId;
    weekStart: Date;
  }): string {
    return [
      EngagementEventType.REACTION_CREATED,
      actorId.toString(),
      postId.toString(),
      getRecapWeekKey(weekStart),
    ].join(':');
  }

  private isDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }
}
