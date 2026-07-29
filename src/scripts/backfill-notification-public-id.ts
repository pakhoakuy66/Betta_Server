import { config } from 'dotenv';
import mongoose, { Types } from 'mongoose';
import {
  Notification,
  NotificationSchema,
} from '../modules/notifications/schemas/notifications.schema';
import { generateNotificationPublicId } from '../modules/notifications/utils/notification-public-id';

config();

const MAX_RETRIES = 5;
const BATCH_SIZE = 200;
const CONCURRENCY = 20;

const MISSING_PUBLIC_ID_FILTER = {
  $or: [{ publicId: { $exists: false } }, { publicId: null }],
};

const NotificationModel = mongoose.model<Notification>(
  Notification.name,
  NotificationSchema,
);

function getMongoUri(): string {
  const uri = process.env.MONGO_URI ?? process.env.DATABASE_URL;

  if (!uri) {
    throw new Error('Missing MONGO_URI or DATABASE_URL');
  }

  return uri;
}

async function assignPublicId(
  notificationId: Types.ObjectId,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await NotificationModel.updateOne(
        {
          _id: notificationId,
          ...MISSING_PUBLIC_ID_FILTER,
        },
        {
          $set: {
            publicId: generateNotificationPublicId(),
          },
        },
        {
          runValidators: true,
          timestamps: false,
        },
      ).exec();

      return result.modifiedCount === 1;
    } catch (error: unknown) {
      const mongoError = error as {
        code?: number;
      };

      if (mongoError.code === 11000) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Không thể tạo publicId cho notification ${notificationId.toString()}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unsupportedArguments = args.filter(
    (argument) => argument !== '--execute',
  );

  if (unsupportedArguments.length > 0) {
    throw new Error(
      `Tham số không được hỗ trợ: ${unsupportedArguments.join(', ')}`,
    );
  }

  const execute = args.includes('--execute');

  await mongoose.connect(getMongoUri());

  try {
    const missingBefore = await NotificationModel.countDocuments(
      MISSING_PUBLIC_ID_FILTER,
    ).exec();

    if (!execute) {
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            missingPublicId: missingBefore,
          },
          null,
          2,
        ),
      );
      return;
    }

    let updated = 0;

    while (true) {
      const notifications = await NotificationModel.find(
        MISSING_PUBLIC_ID_FILTER,
      )
        .select('_id')
        .limit(BATCH_SIZE)
        .lean<{ _id: Types.ObjectId }[]>()
        .exec();

      if (notifications.length === 0) break;

      for (let index = 0; index < notifications.length; index += CONCURRENCY) {
        const chunk = notifications.slice(index, index + CONCURRENCY);

        const results = await Promise.all(
          chunk.map((notification) => assignPublicId(notification._id)),
        );

        updated += results.filter(Boolean).length;
      }
    }

    const remaining = await NotificationModel.countDocuments(
      MISSING_PUBLIC_ID_FILTER,
    ).exec();

    if (remaining !== 0) {
      throw new Error(`Backfill chưa hoàn tất: còn ${remaining} notification`);
    }

    console.log(
      JSON.stringify(
        {
          mode: 'execute',
          found: missingBefore,
          updated,
          remaining,
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Backfill notification publicId thất bại',
  );
  process.exitCode = 1;
});
