import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import { StreakHistory } from '../schemas/streak.schema';

const STREAK_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAILY_POST_STREAK_INCREMENT = 1;
const MISSED_DAY_DECAY_RATE = 0.2;
const DEFAULT_STREAK_DECAY_BATCH_SIZE = 100;

type StreakUpdateResult = {
  awarded: boolean;
  date: string;
  streakCount?: number;
};

type StreakDecaySummary = {
  date: string;
  processed: number;
  decayed: number;
  skipped: number;
  failed: number;
};

type MongoDuplicateKeyError = {
  code?: number;
};

type UserStreakLean = {
  _id: Types.ObjectId;
  streakCount: number;
};

type StreakCandidateLean = {
  _id: Types.ObjectId;
  streakCount: number;
};

type StreakCandidateFilter = {
  isDeleted: false;
  status: 'active';
  streakCount: { $gt: number };
  _id?: { $gt: Types.ObjectId };
};

@Injectable()
export class StreakService {
  private readonly logger = new Logger(StreakService.name);

  private readonly dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: STREAK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(StreakHistory.name)
    private readonly streakHistoryModel: Model<StreakHistory>,
  ) {}

  async recordPostCreated(
    userId: Types.ObjectId,
    occurredAt = new Date(),
  ): Promise<StreakUpdateResult> {
    const dateKey = this.toLocalDateKey(occurredAt);
    const session = await this.connection.startSession();

    try {
      let result: StreakUpdateResult = {
        awarded: false,
        date: dateKey,
      };

      await session.withTransaction(async () => {
        const historyResult = await this.streakHistoryModel
          .updateOne(
            {
              userId,
              date: dateKey,
            },
            {
              $setOnInsert: {
                userId,
                date: dateKey,
                hasPosted: true,
                pointsChanged: DAILY_POST_STREAK_INCREMENT,
                currentStreakCount: 0,
              },
            },
            {
              upsert: true,
              session,
            },
          )
          .exec();

        if (historyResult.upsertedCount !== 1) {
          result = {
            awarded: false,
            date: dateKey,
          };
          return;
        }

        const updatedUser = await this.userModel
          .findOneAndUpdate(
            {
              _id: userId,
              isDeleted: false,
              status: 'active',
            },
            {
              $inc: {
                streakCount: DAILY_POST_STREAK_INCREMENT,
              },
            },
            {
              session,
              new: true,
              projection: {
                _id: 1,
                streakCount: 1,
              },
            },
          )
          .lean<UserStreakLean>()
          .exec();

        if (!updatedUser) {
          throw new Error(
            `Cannot increment streak because active user was not found: ${userId.toString()}`,
          );
        }

        await this.streakHistoryModel
          .updateOne(
            {
              userId,
              date: dateKey,
            },
            {
              $set: {
                currentStreakCount: updatedUser.streakCount,
              },
            },
            {
              session,
            },
          )
          .exec();

        result = {
          awarded: true,
          date: dateKey,
          streakCount: updatedUser.streakCount,
        };
      });

      return result;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return {
          awarded: false,
          date: dateKey,
        };
      }

      this.logger.warn(
        `[STREAK_RECORD_POST_FAILED] user=${userId.toString()} date=${dateKey}`,
        error instanceof Error ? error.stack : String(error),
      );

      return {
        awarded: false,
        date: dateKey,
      };
    } finally {
      await session.endSession();
    }
  }

  async decayUsersWithoutPostForPreviousDay(
    now = new Date(),
  ): Promise<StreakDecaySummary> {
    const targetDate = this.toPreviousLocalDateKey(now);

    return this.decayUsersWithoutPostForDate(targetDate);
  }

  async decayUsersWithoutPostForDate(
    dateKey: string,
    batchSize = DEFAULT_STREAK_DECAY_BATCH_SIZE,
  ): Promise<StreakDecaySummary> {
    const summary: StreakDecaySummary = {
      date: dateKey,
      processed: 0,
      decayed: 0,
      skipped: 0,
      failed: 0,
    };

    let lastId: Types.ObjectId | undefined;

    while (true) {
      const filter: StreakCandidateFilter = {
        isDeleted: false,
        status: 'active',
        streakCount: { $gt: 0 },
      };

      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const candidates = await this.userModel
        .find(filter)
        .select('_id streakCount')
        .sort({ _id: 1 })
        .limit(batchSize)
        .lean<StreakCandidateLean[]>()
        .exec();

      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        summary.processed += 1;

        try {
          const result = await this.decayOneUserForDate(candidate, dateKey);

          if (result === 'decayed') {
            summary.decayed += 1;
          } else {
            summary.skipped += 1;
          }
        } catch (error) {
          summary.failed += 1;

          this.logger.warn(
            `[STREAK_DECAY_USER_FAILED] user=${candidate._id.toString()} date=${dateKey}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      lastId = candidates[candidates.length - 1]._id;
    }

    this.logger.log(
      `Streak decay finished. date=${summary.date}, processed=${summary.processed}, decayed=${summary.decayed}, skipped=${summary.skipped}, failed=${summary.failed}`,
    );

    return summary;
  }

  private async decayOneUserForDate(
    user: StreakCandidateLean,
    dateKey: string,
  ): Promise<'decayed' | 'skipped'> {
    const session = await this.connection.startSession();

    try {
      let result: 'decayed' | 'skipped' = 'skipped';

      await session.withTransaction(async () => {
        const existingHistory = await this.streakHistoryModel
          .findOne({
            userId: user._id,
            date: dateKey,
          })
          .select('_id')
          .session(session)
          .lean<{ _id: Types.ObjectId }>()
          .exec();

        if (existingHistory) {
          result = 'skipped';
          return;
        }

        const currentUser = await this.userModel
          .findOne({
            _id: user._id,
            isDeleted: false,
            status: 'active',
            streakCount: { $gt: 0 },
          })
          .select('_id streakCount')
          .session(session)
          .lean<UserStreakLean>()
          .exec();

        if (!currentUser) {
          result = 'skipped';
          return;
        }

        const decrement = this.calculateMissedDayDecrement(
          currentUser.streakCount,
        );
        const nextStreakCount = Math.max(
          0,
          currentUser.streakCount - decrement,
        );

        await this.streakHistoryModel.create(
          [
            {
              userId: currentUser._id,
              date: dateKey,
              hasPosted: false,
              pointsChanged: -decrement,
              currentStreakCount: nextStreakCount,
            },
          ],
          { session },
        );

        const updateResult = await this.userModel
          .updateOne(
            {
              _id: currentUser._id,
              streakCount: currentUser.streakCount,
            },
            {
              $set: {
                streakCount: nextStreakCount,
              },
            },
            { session },
          )
          .exec();

        if (updateResult.modifiedCount !== 1) {
          throw new Error(
            `Streak count changed during decay: user=${currentUser._id.toString()} date=${dateKey}`,
          );
        }

        result = 'decayed';
      });

      return result;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return 'skipped';
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  private calculateMissedDayDecrement(streakCount: number): number {
    if (streakCount <= 0) return 0;

    return Math.max(1, Math.ceil(streakCount * MISSED_DAY_DECAY_RATE));
  }

  private toPreviousLocalDateKey(now: Date): string {
    const previousDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return this.toLocalDateKey(previousDay);
  }

  private toLocalDateKey(date: Date): string {
    return this.dateFormatter.format(date);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as MongoDuplicateKeyError).code === 11000
    );
  }
}
