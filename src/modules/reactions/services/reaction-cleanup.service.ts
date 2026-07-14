import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Post } from '../../posts/schemas/post.schema';
import {
  WeeklyRecapRun,
  WeeklyRecapRunStatus,
} from '../../recap/schemas/weekly-recap-run.schema';
import { RECAP_TIMEZONE } from '../../recap/utils/recap-week.util';
import { ReactionCleanupCursor } from '../schemas/reaction-cleanup-cursor.schema';
import { Reaction } from '../schemas/reaction.schema';

const JOB_NAME = 'reaction-cleanup';
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 2_000;
const DEFAULT_MAX_WEEKS = 20;
const MAX_WEEKS = 60;
const FUTURE_TOLERANCE_MS = 60_000;

export const REACTION_CLEANUP_PRODUCTION_CONFIRMATION =
  'DELETE_ELIGIBLE_REACTIONS';

type CompletedWeek = {
  _id: Types.ObjectId;
  weekKey: string;
  weekStart: Date;
  weekEnd: Date;
  timezone: string;
};

type CleanupCursorPosition = {
  lastWeekStart: Date;
  lastRunId: Types.ObjectId;
};

type ReactionCandidate = {
  _id: unknown;
  postId: unknown;
  createdAt: Date;
};

type ValidReactionCandidate = {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  createdAt: Date;
};

type RevalidatedPost = {
  _id: Types.ObjectId;
  expireAt?: Date | null;
};

type RevalidationResult = {
  deletableIds: Types.ObjectId[];
  malformedPostIds: number;
  malformedReactionIds: number;
};

export type ReactionCleanupOptions = {
  execute?: boolean;
  now?: Date;
  batchSize?: number;
  maxWeeks?: number;
  productionConfirmation?: string;
};

export type ReactionCleanupResult = {
  success: boolean;
  execute: boolean;
  database: string;
  timezone: string;
  scannedWeeks: number;
  fullyScannedWeeks: number;
  weeksWithCandidates: number;
  observedEligible: number;
  malformedPostIds: number;
  malformedReactionIds: number;
  planned: number;
  processed: number;
  deleted: number;
  skipped: number;
  failedWeeks: number;
  wrappedCursor: boolean;
  cursorAdvancedTo: string | null;
  hasMore: boolean;
  fromWeekKey: string | null;
  throughWeekKey: string | null;
  durationMs: number;
};

@Injectable()
export class ReactionCleanupService {
  private readonly logger = new Logger(ReactionCleanupService.name);

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(Reaction.name)
    private readonly reactionModel: Model<Reaction>,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(WeeklyRecapRun.name)
    private readonly weeklyRecapRunModel: Model<WeeklyRecapRun>,
    @InjectModel(ReactionCleanupCursor.name)
    private readonly cursorModel: Model<ReactionCleanupCursor>,
  ) {}

  async cleanupEligibleReactions(
    options: ReactionCleanupOptions = {},
  ): Promise<ReactionCleanupResult> {
    const startedAt = Date.now();

    const rawOptions: {
      execute: unknown;
      now: unknown;
      batchSize: unknown;
      maxWeeks: unknown;
      productionConfirmation: unknown;
    } = {
      execute: options.execute ?? false,
      now: options.now ?? new Date(),
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      maxWeeks: options.maxWeeks ?? DEFAULT_MAX_WEEKS,
      productionConfirmation: options.productionConfirmation,
    };

    this.validateOptions(rawOptions);

    const execute = rawOptions.execute;
    const now = rawOptions.now;
    const batchSize = rawOptions.batchSize;
    const maxWeeks = rawOptions.maxWeeks;

    const database = this.connection.db;

    if (!database) {
      throw new Error('MongoDB chưa sẵn sàng');
    }

    const cursor = await this.cursorModel
      .findOne({ jobName: JOB_NAME })
      .select('lastWeekStart lastRunId')
      .lean<{
        lastWeekStart: Date | null;
        lastRunId: Types.ObjectId | null;
      }>()
      .exec();

    const cursorPosition: CleanupCursorPosition | null =
      cursor?.lastWeekStart && cursor.lastRunId instanceof Types.ObjectId
        ? {
            lastWeekStart: cursor.lastWeekStart,
            lastRunId: cursor.lastRunId,
          }
        : null;

    let wrappedCursor = false;
    let weeks = await this.findCompletedWeeks(
      now,
      cursorPosition,
      maxWeeks + 1,
    );

    if (weeks.length === 0 && cursorPosition) {
      wrappedCursor = true;
      weeks = await this.findCompletedWeeks(now, null, maxWeeks + 1);
    }

    const hasMoreCompletedWeeks = weeks.length > maxWeeks;
    const selectedWeeks = weeks.slice(0, maxWeeks);

    let observedEligible = 0;
    let planned = 0;
    let processed = 0;
    let deleted = 0;
    let skipped = 0;
    let failedWeeks = 0;
    let fullyScannedWeeks = 0;
    let weeksWithCandidates = 0;
    let malformedPostIds = 0;
    let malformedReactionIds = 0;
    let remainingBudget = batchSize;
    let stoppedAtTruncatedWeek = false;
    let stoppedBeforeAllSelectedWeeks = false;
    let stoppedAtChangedRun = false;
    let lastFullyScannedWeek: CompletedWeek | null = null;

    for (const week of selectedWeeks) {
      if (remainingBudget === 0) {
        stoppedBeforeAllSelectedWeeks = true;
        break;
      }

      try {
        const candidates = await this.findCandidates(
          week,
          now,
          remainingBudget + 1,
        );

        const weekHasMoreCandidates = candidates.length > remainingBudget;
        const selectedCandidates = candidates.slice(0, remainingBudget);

        observedEligible += candidates.length;

        if (selectedCandidates.length > 0) {
          weeksWithCandidates += 1;
        }

        /*
         * Dry-run cũng revalidate để planned và malformed
         * metrics phản ánh dữ liệu thật, nhưng không mutation.
         */
        const revalidation = await this.revalidateCandidates(
          selectedCandidates,
          now,
        );

        malformedPostIds += revalidation.malformedPostIds;
        malformedReactionIds += revalidation.malformedReactionIds;
        planned += revalidation.deletableIds.length;

        const completedRunStillExists = await this.weeklyRecapRunModel.exists({
          _id: week._id,
          weekKey: week.weekKey,
          timezone: RECAP_TIMEZONE,
          status: WeeklyRecapRunStatus.COMPLETED,
          weekStart: week.weekStart,
          weekEnd: week.weekEnd,
        });

        if (!completedRunStillExists) {
          stoppedAtChangedRun = true;
          break;
        }

        if (execute && selectedCandidates.length > 0) {
          processed += selectedCandidates.length;

          if (revalidation.deletableIds.length === 0) {
            skipped += selectedCandidates.length;
          } else {
            const deletion = await this.reactionModel.deleteMany({
              _id: {
                $in: revalidation.deletableIds,
              },
              createdAt: {
                $gte: week.weekStart,
                $lt: week.weekEnd,
              },
            });

            deleted += deletion.deletedCount;
            skipped += selectedCandidates.length - deletion.deletedCount;
          }
        }

        remainingBudget -= selectedCandidates.length;

        if (weekHasMoreCandidates) {
          stoppedAtTruncatedWeek = true;
          break;
        }

        fullyScannedWeeks += 1;
        lastFullyScannedWeek = week;
      } catch (error) {
        failedWeeks += 1;

        this.logger.error(
          `Reaction cleanup failed for week=${week.weekKey}`,
          error instanceof Error ? error.stack : String(error),
        );

        break;
      }
    }

    if (execute && lastFullyScannedWeek) {
      await this.cursorModel.updateOne(
        { jobName: JOB_NAME },
        {
          $set: {
            lastWeekStart: lastFullyScannedWeek.weekStart,
            lastRunId: lastFullyScannedWeek._id,
          },
          $setOnInsert: {
            jobName: JOB_NAME,
          },
        },
        { upsert: true },
      );
    }

    const hasMore =
      hasMoreCompletedWeeks ||
      stoppedAtTruncatedWeek ||
      stoppedBeforeAllSelectedWeeks ||
      stoppedAtChangedRun ||
      failedWeeks > 0 ||
      fullyScannedWeeks < selectedWeeks.length;

    const result: ReactionCleanupResult = {
      success: failedWeeks === 0,
      execute,
      database: database.databaseName,
      timezone: RECAP_TIMEZONE,
      scannedWeeks: selectedWeeks.length,
      fullyScannedWeeks,
      weeksWithCandidates,
      observedEligible,
      malformedPostIds,
      malformedReactionIds,
      planned,
      processed,
      deleted,
      skipped,
      failedWeeks,
      wrappedCursor,
      cursorAdvancedTo: execute
        ? (lastFullyScannedWeek?.weekKey ?? null)
        : null,
      hasMore,
      fromWeekKey: selectedWeeks[0]?.weekKey ?? null,
      throughWeekKey: selectedWeeks[selectedWeeks.length - 1]?.weekKey ?? null,
      durationMs: Date.now() - startedAt,
    };

    this.logResult(result, batchSize, maxWeeks);

    return result;
  }

  private validateOptions(options: {
    execute: unknown;
    now: unknown;
    batchSize: unknown;
    maxWeeks: unknown;
    productionConfirmation: unknown;
  }): asserts options is {
    execute: boolean;
    now: Date;
    batchSize: number;
    maxWeeks: number;
    productionConfirmation: string | undefined;
  } {
    if (typeof options.execute !== 'boolean') {
      throw new BadRequestException('execute phải là boolean');
    }

    if (!(options.now instanceof Date) || Number.isNaN(options.now.getTime())) {
      throw new BadRequestException('Thời điểm cleanup không hợp lệ');
    }

    if (
      options.productionConfirmation !== undefined &&
      typeof options.productionConfirmation !== 'string'
    ) {
      throw new BadRequestException('Production confirmation không hợp lệ');
    }

    if (
      typeof options.batchSize !== 'number' ||
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > MAX_BATCH_SIZE
    ) {
      throw new BadRequestException(
        `Batch size phải từ 1 đến ${MAX_BATCH_SIZE}`,
      );
    }

    if (
      typeof options.maxWeeks !== 'number' ||
      !Number.isInteger(options.maxWeeks) ||
      options.maxWeeks < 1 ||
      options.maxWeeks > MAX_WEEKS
    ) {
      throw new BadRequestException(`Số tuần quét phải từ 1 đến ${MAX_WEEKS}`);
    }

    if (
      process.env.NODE_ENV === 'production' &&
      options.now.getTime() > Date.now() + FUTURE_TOLERANCE_MS
    ) {
      throw new BadRequestException(
        'Production không cho phép thời điểm cleanup trong tương lai',
      );
    }

    if (
      process.env.NODE_ENV === 'production' &&
      options.execute &&
      options.productionConfirmation !==
        REACTION_CLEANUP_PRODUCTION_CONFIRMATION
    ) {
      throw new BadRequestException(
        'Thiếu xác nhận cleanup reaction production',
      );
    }
  }

  private async findCompletedWeeks(
    now: Date,
    cursor: CleanupCursorPosition | null,
    limit: number,
  ): Promise<CompletedWeek[]> {
    const baseFilter = {
      timezone: RECAP_TIMEZONE,
      status: WeeklyRecapRunStatus.COMPLETED,
      weekEnd: { $lte: now },
    };

    const filter = cursor
      ? {
          ...baseFilter,
          $or: [
            {
              weekStart: {
                $gt: cursor.lastWeekStart,
              },
            },
            {
              weekStart: cursor.lastWeekStart,
              _id: {
                $gt: cursor.lastRunId,
              },
            },
          ],
        }
      : baseFilter;

    return this.weeklyRecapRunModel
      .find(filter)
      .sort({
        weekStart: 1,
        _id: 1,
      })
      .limit(limit)
      .select('_id weekKey weekStart weekEnd timezone')
      .lean<CompletedWeek[]>()
      .exec();
  }

  private async findCandidates(
    week: CompletedWeek,
    now: Date,
    limit: number,
  ): Promise<ReactionCandidate[]> {
    return this.reactionModel
      .aggregate<ReactionCandidate>([
        {
          $match: {
            createdAt: {
              $gte: week.weekStart,
              $lt: week.weekEnd,
            },
          },
        },
        {
          $sort: {
            createdAt: 1,
            _id: 1,
          },
        },
        {
          $lookup: {
            from: this.postModel.collection.collectionName,
            let: {
              referencedPostId: '$postId',
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$referencedPostId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                  expireAt: 1,
                },
              },
              { $limit: 1 },
            ],
            as: 'referencedPost',
          },
        },
        {
          $match: {
            $or: [
              {
                referencedPost: { $eq: [] },
              },
              {
                'referencedPost.0.expireAt': {
                  $type: 'date',
                  $lte: now,
                },
              },
            ],
          },
        },
        {
          $project: {
            _id: 1,
            postId: 1,
            createdAt: 1,
          },
        },
        { $limit: limit },
      ])
      .allowDiskUse(false)
      .exec();
  }

  private async revalidateCandidates(
    candidates: ReactionCandidate[],
    now: Date,
  ): Promise<RevalidationResult> {
    const validCandidates: ValidReactionCandidate[] = [];

    let malformedPostIds = 0;
    let malformedReactionIds = 0;

    for (const candidate of candidates) {
      if (!(candidate._id instanceof Types.ObjectId)) {
        malformedReactionIds += 1;
        continue;
      }

      if (!(candidate.postId instanceof Types.ObjectId)) {
        malformedPostIds += 1;
        continue;
      }

      validCandidates.push({
        _id: candidate._id,
        postId: candidate.postId,
        createdAt: candidate.createdAt,
      });
    }

    const uniquePostIds = [
      ...new Map(
        validCandidates.map((candidate) => [
          candidate.postId.toHexString(),
          candidate.postId,
        ]),
      ).values(),
    ];

    const existingPosts =
      uniquePostIds.length === 0
        ? []
        : await this.postModel
            .find({
              _id: { $in: uniquePostIds },
            })
            .select('_id expireAt')
            .lean<RevalidatedPost[]>()
            .exec();

    const postsById = new Map(
      existingPosts.map((post) => [post._id.toHexString(), post]),
    );

    const deletableIds = validCandidates
      .filter((candidate) => {
        const post = postsById.get(candidate.postId.toHexString());

        if (!post) return true;

        if (
          !(post.expireAt instanceof Date) ||
          Number.isNaN(post.expireAt.getTime())
        ) {
          return false;
        }

        return post.expireAt.getTime() <= now.getTime();
      })
      .map((candidate) => candidate._id);

    return {
      deletableIds,
      malformedPostIds,
      malformedReactionIds,
    };
  }

  private logResult(
    result: ReactionCleanupResult,
    batchSize: number,
    maxWeeks: number,
  ): void {
    const summary = [
      'Reaction cleanup finished.',
      `database=${result.database}`,
      `execute=${result.execute}`,
      `timezone=${result.timezone}`,
      `scannedWeeks=${result.scannedWeeks}`,
      `fullyScannedWeeks=${result.fullyScannedWeeks}`,
      `observedEligible=${result.observedEligible}`,
      `planned=${result.planned}`,
      `processed=${result.processed}`,
      `deleted=${result.deleted}`,
      `skipped=${result.skipped}`,
      `malformedPostIds=${result.malformedPostIds}`,
      `malformedReactionIds=${result.malformedReactionIds}`,
      `failedWeeks=${result.failedWeeks}`,
      `cursorAdvancedTo=${result.cursorAdvancedTo ?? 'none'}`,
      `hasMore=${result.hasMore}`,
      `wrappedCursor=${result.wrappedCursor}`,
      `batchSize=${batchSize}`,
      `maxWeeks=${maxWeeks}`,
      `durationMs=${result.durationMs}`,
    ].join(' ');

    if (!result.success) {
      this.logger.error(summary);
      return;
    }

    if (
      result.malformedPostIds > 0 ||
      result.malformedReactionIds > 0 ||
      result.hasMore
    ) {
      this.logger.warn(summary);
      return;
    }

    this.logger.log(summary);
  }
}
