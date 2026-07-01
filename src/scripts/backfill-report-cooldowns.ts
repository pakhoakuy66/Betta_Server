import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { ReportTargetType } from '../modules/reports/schemas/report.schema';
import { ReportCooldownSchema } from '../modules/reports/schemas/report-cooldown.schema';

const POST_REPORT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const USER_REPORT_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

type ReportDocument = {
  _id: Types.ObjectId;
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  createdAt: Date;
};

type LatestReportForCooldown = {
  reportId: Types.ObjectId;
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  createdAt: Date;
};

async function bootstrap() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  await mongoose.connect(databaseUrl);

  const ReportModel = mongoose.connection.collection<ReportDocument>('reports');

  const ReportCooldownModel = mongoose.model(
    'ReportCooldown',
    ReportCooldownSchema,
  );

  const now = new Date();

  const recentReports = await ReportModel.aggregate<LatestReportForCooldown>([
    {
      $match: {
        targetType: {
          $in: [ReportTargetType.POST, ReportTargetType.USER],
        },
        createdAt: {
          $gte: new Date(now.getTime() - USER_REPORT_COOLDOWN_MS),
        },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: {
          reporterId: '$reporterId',
          targetType: '$targetType',
          targetId: '$targetId',
        },
        reportId: { $first: '$_id' },
        reporterId: { $first: '$reporterId' },
        targetType: { $first: '$targetType' },
        targetId: { $first: '$targetId' },
        createdAt: { $first: '$createdAt' },
      },
    },
  ]).toArray();

  let upserted = 0;
  let skipped = 0;

  for (const report of recentReports) {
    const cooldownMs =
      report.targetType === ReportTargetType.POST
        ? POST_REPORT_COOLDOWN_MS
        : USER_REPORT_COOLDOWN_MS;

    const nextAllowedAt = new Date(report.createdAt.getTime() + cooldownMs);

    if (nextAllowedAt <= now) {
      skipped += 1;
      continue;
    }

    await ReportCooldownModel.updateOne(
      {
        reporterId: report.reporterId,
        targetType: report.targetType,
        targetId: report.targetId,
      },
      {
        $set: {
          nextAllowedAt,
          lastReportId: report.reportId,
        },
        $setOnInsert: {
          reporterId: report.reporterId,
          targetType: report.targetType,
          targetId: report.targetId,
        },
      },
      { upsert: true },
    ).exec();

    upserted += 1;
  }

  console.log(
    `Backfill report cooldowns finished. scanned=${recentReports.length}, upserted=${upserted}, skipped=${skipped}`,
  );

  await mongoose.disconnect();
}

void bootstrap().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
