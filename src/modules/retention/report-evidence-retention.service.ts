import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Post } from '../posts/schemas/post.schema';
import { RetentionCleanupStatus } from '../reports/schemas/report-retention.schema';
import {
  Report,
  ReportStatus,
  ReportTargetType,
} from '../reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportStatus,
} from '../reports/schemas/system-report.schema';
import { CloudinaryAssetHealthService } from '../uploads/services/cloudinary-asset-health.service';
import { UploadsService } from '../uploads/services/uploads.service';
import type { CollectionCleanupResult } from './retention.types';

const DAY_MS = 86_400_000;
const EVIDENCE_GRACE_DAYS = 30;
const SAFE_METADATA_DAYS = 365;
const LOCK_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type ClaimedEvidence = Readonly<{
  _id: Types.ObjectId;
  evidenceImages?: readonly Readonly<{ publicId?: string }>[];
  retentionAttempts?: number;
}>;

type MissingPostCandidate = Readonly<{
  _id: Types.ObjectId;
  targetId: Types.ObjectId;
  targetSnapshot?: Readonly<{
    images?: readonly Readonly<{ publicId?: string }>[];
  }>;
}>;

type CleanupOutcome =
  | 'updated'
  | 'deleted'
  | 'failed'
  | 'lost'
  | 'manual_review'
  | 'none';

@Injectable()
export class ReportEvidenceRetentionService {
  constructor(
    @InjectModel(Report.name)
    private readonly reports: Model<Report>,
    @InjectModel(SystemReport.name)
    private readonly systemReports: Model<SystemReport>,
    @InjectModel(Post.name)
    private readonly posts: Model<Post>,
    private readonly uploads: UploadsService,
    private readonly assetHealth: CloudinaryAssetHealthService,
  ) {}

  async reconcileExhaustedClaims(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const reportFilter = this.exhaustedFilter(now, [
      ReportStatus.RESOLVED,
      ReportStatus.REJECTED,
    ]);
    const systemFilter = this.exhaustedFilter(now, [
      SystemReportStatus.FIXED,
      SystemReportStatus.CLOSED,
    ]);
    const reportCount = await this.reports.countDocuments(reportFilter, {
      limit: budget + 1,
    });
    const systemBudget = Math.max(0, budget - Math.min(reportCount, budget));
    const systemCount = await this.systemReports.countDocuments(systemFilter, {
      limit: systemBudget + 1,
    });
    const eligible = reportCount + systemCount;
    const planned = Math.min(eligible, budget);

    if (!execute || planned === 0) {
      return this.result(
        'report_retention_manual_review',
        eligible,
        planned,
        startedAt,
        {
          truncated: eligible > budget,
        },
      );
    }

    const message =
      'Retention cleanup vượt giới hạn retry và cần kiểm tra thủ công';
    const update = {
      $set: {
        retentionCleanupStatus: RetentionCleanupStatus.MANUAL_REVIEW,
        retentionLockedUntil: null,
        retentionLockToken: null,
        retentionLastError: message,
      },
    };
    const reportLimit = Math.min(reportCount, budget);
    const reportIds = await this.findIds(
      this.reports,
      reportFilter,
      reportLimit,
    );
    const reportUpdate = reportIds.length
      ? await this.reports.updateMany(
          { $and: [reportFilter, { _id: { $in: reportIds } }] },
          update,
        )
      : { modifiedCount: 0 };
    const remaining = budget - reportIds.length;
    const systemIds = await this.findIds(
      this.systemReports,
      systemFilter,
      Math.min(systemCount, remaining),
    );
    const systemUpdate = systemIds.length
      ? await this.systemReports.updateMany(
          { $and: [systemFilter, { _id: { $in: systemIds } }] },
          update,
        )
      : { modifiedCount: 0 };
    const processed = reportIds.length + systemIds.length;
    const updated = reportUpdate.modifiedCount + systemUpdate.modifiedCount;

    return this.result(
      'report_retention_manual_review',
      eligible,
      planned,
      startedAt,
      {
        processed,
        updated,
        manualReview: updated,
        skipped: processed - updated,
        truncated: eligible > budget,
      },
    );
  }

  async reconcileMissingPostEvidence(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const graceCutoff = this.cutoff(now, EVIDENCE_GRACE_DAYS);
    const filter = {
      targetType: ReportTargetType.POST,
      evidenceUnavailable: { $ne: true },
      'targetSnapshot.images.0': { $exists: true },
      $and: [
        this.notPurgedFilter(),
        {
          $or: [
            { status: { $in: [ReportStatus.PENDING, ReportStatus.REVIEWING] } },
            {
              status: { $in: [ReportStatus.RESOLVED, ReportStatus.REJECTED] },
              terminalAt: { $gt: graceCutoff },
            },
          ],
        },
      ],
    };
    const observed = await this.reports.countDocuments(filter, {
      limit: budget + 1,
    });
    const planned = Math.min(observed, budget);

    if (!execute || planned === 0) {
      return this.result(
        'report_evidence_reconciliation',
        observed,
        planned,
        startedAt,
        {
          truncated: observed > budget,
        },
      );
    }

    const candidates = await this.reports
      .find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(planned)
      .select('_id targetId targetSnapshot.images.publicId')
      .lean<MissingPostCandidate[]>()
      .exec();
    const targetIds = [
      ...new Set(candidates.map(({ targetId }) => targetId.toString())),
    ].map((value) => new Types.ObjectId(value));
    const existingPosts = await this.posts
      .find({ _id: { $in: targetIds } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const existing = new Set(existingPosts.map(({ _id }) => _id.toString()));
    const missingTargetCandidates = candidates.filter(
      ({ targetId }) => !existing.has(targetId.toString()),
    );
    const existingTargetCandidates = candidates.filter(({ targetId }) =>
      existing.has(targetId.toString()),
    );
    const publicIds = existingTargetCandidates.flatMap((candidate) =>
      (candidate.targetSnapshot?.images ?? [])
        .map(({ publicId }) => publicId?.trim() ?? '')
        .filter(Boolean),
    );
    let missingAssetPublicIds = new Set<string>();
    let assetCheckFailed = 0;

    try {
      missingAssetPublicIds = new Set(
        await this.assetHealth.findMissingImagePublicIds(publicIds),
      );
    } catch {
      /*
       * Không suy diễn asset mất khi Cloudinary/Admin API đang lỗi. Ghi nhận
       * failure để top-level fail closed và để lần chạy sau kiểm tra lại.
       */
      assetCheckFailed = existingTargetCandidates.length;
    }

    const missingIds = [
      ...missingTargetCandidates,
      ...(assetCheckFailed > 0
        ? []
        : existingTargetCandidates.filter((candidate) => {
            const snapshotPublicIds = (
              candidate.targetSnapshot?.images ?? []
            ).map(({ publicId }) => publicId?.trim() ?? '');
            return (
              snapshotPublicIds.some((publicId) => !publicId) ||
              snapshotPublicIds.some((publicId) =>
                missingAssetPublicIds.has(publicId),
              )
            );
          })),
    ].map(({ _id }) => _id);
    const update = missingIds.length
      ? await this.reports.updateMany(
          { _id: { $in: missingIds }, evidenceUnavailable: { $ne: true } },
          { $set: { evidenceUnavailable: true } },
        )
      : { modifiedCount: 0 };

    return this.result(
      'report_evidence_reconciliation',
      observed,
      planned,
      startedAt,
      {
        processed: candidates.length,
        updated: update.modifiedCount,
        failed: assetCheckFailed,
        skipped: candidates.length - update.modifiedCount - assetCheckFailed,
        truncated: observed > budget,
      },
    );
  }

  purgeReportEvidence(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    return this.processClaims(
      'reports_evidence',
      this.reports,
      this.purgeFilter(now),
      budget,
      execute,
      now,
      () => this.processOneReportPurge(now),
    );
  }

  purgeSystemReportEvidence(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    return this.processClaims(
      'system_reports_evidence',
      this.systemReports,
      this.systemPurgeFilter(now),
      budget,
      execute,
      now,
      () => this.processOneSystemReportPurge(now),
    );
  }

  deleteSafeReportMetadata(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    return this.processClaims(
      'reports_safe_metadata',
      this.reports,
      this.safeReportDeleteFilter(now),
      budget,
      execute,
      now,
      () =>
        this.processOneSafeDelete(
          this.reports,
          now,
          this.safeReportDeleteFilter(now),
          this.reportSafeDeleteTerminalFilter(now),
        ),
    );
  }

  deleteSafeSystemReportMetadata(
    budget: number,
    execute: boolean,
    now: Date,
  ): Promise<CollectionCleanupResult> {
    return this.processClaims(
      'system_reports_safe_metadata',
      this.systemReports,
      this.safeSystemReportDeleteFilter(now),
      budget,
      execute,
      now,
      () =>
        this.processOneSafeDelete(
          this.systemReports,
          now,
          this.safeSystemReportDeleteFilter(now),
          this.systemReportSafeDeleteTerminalFilter(now),
        ),
    );
  }

  private async processClaims<T extends Report | SystemReport>(
    collection: string,
    model: Model<T>,
    filter: Record<string, unknown>,
    budget: number,
    execute: boolean,
    now: Date,
    processOne: () => Promise<CleanupOutcome>,
  ): Promise<CollectionCleanupResult> {
    const startedAt = Date.now();
    const observed = await model.countDocuments(filter, { limit: budget + 1 });
    const planned = Math.min(observed, budget);

    if (!execute || planned === 0) {
      return this.result(collection, observed, planned, startedAt, {
        truncated: observed > budget,
      });
    }

    let processed = 0;
    let updated = 0;
    let deleted = 0;
    let failed = 0;
    let lostOwnership = 0;
    let manualReview = 0;

    for (let index = 0; index < planned; index += 1) {
      const outcome = await processOne();
      if (outcome === 'none') break;
      processed += 1;
      if (outcome === 'updated') updated += 1;
      if (outcome === 'deleted') deleted += 1;
      if (outcome === 'failed') failed += 1;
      if (outcome === 'lost') lostOwnership += 1;
      if (outcome === 'manual_review') manualReview += 1;
    }

    return this.result(collection, observed, planned, startedAt, {
      processed,
      updated,
      deleted,
      failed,
      lostOwnership,
      manualReview,
      skipped:
        processed - updated - deleted - failed - lostOwnership - manualReview,
      truncated: observed > budget,
    });
  }

  private async processOneReportPurge(now: Date): Promise<CleanupOutcome> {
    const token = randomUUID();
    const claimed = await this.claim(
      this.reports,
      this.purgeFilter(now),
      token,
      now,
    );
    if (!claimed) return 'none';

    try {
      /*
       * targetSnapshot is immutable for every application write. Retention is
       * the sole deliberate deletion exception and therefore uses the native
       * collection with the same lease, terminal cutoff and hold CAS.
       */
      const update = await this.reports.collection.updateOne(
        {
          _id: claimed._id,
          ...this.purgeTerminalFilter(now),
          ...this.notActivelyHeldFilter(now),
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockToken: token,
        },
        {
          $set: {
            retentionCleanupStatus: RetentionCleanupStatus.CLEANED,
            retentionLockedUntil: null,
            retentionLockToken: null,
            retentionAttempts: 0,
            retentionLastError: '',
            evidencePurgedAt: now,
            evidenceUnavailable: true,
          },
          $unset: {
            reporterId: '',
            reasonDetail: '',
            description: '',
            adminNote: '',
            'targetSnapshot.authorId': '',
            'targetSnapshot.authorUsername': '',
            'targetSnapshot.content': '',
            'targetSnapshot.images': '',
            'targetSnapshot.username': '',
            'targetSnapshot.fullname': '',
            'targetSnapshot.avatar': '',
            'targetSnapshot.bio': '',
          },
        },
      );
      return update.modifiedCount === 1 ? 'updated' : 'lost';
    } catch (error: unknown) {
      return this.releaseFailure(this.reports, claimed, token, now, error);
    }
  }

  private async processOneSystemReportPurge(
    now: Date,
  ): Promise<CleanupOutcome> {
    const token = randomUUID();
    const claimed = await this.claim(
      this.systemReports,
      this.systemPurgeFilter(now),
      token,
      now,
      'evidenceImages',
    );
    if (!claimed) return 'none';

    try {
      const reserved = await this.reserveSystemReportDestruction(
        claimed._id,
        token,
        now,
      );
      if (!reserved) return 'lost';

      await this.uploads.deleteImages(
        (claimed.evidenceImages ?? [])
          .map(({ publicId }) => publicId ?? '')
          .filter(Boolean),
        { throwOnError: true },
      );
      const update = await this.systemReports.collection.updateOne(
        {
          _id: claimed._id,
          ...this.systemPurgeTerminalFilter(now),
          retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
          retentionLockToken: token,
          retentionDestructiveStartedAt: now,
        },
        {
          $set: {
            evidenceImages: [],
            retentionCleanupStatus: RetentionCleanupStatus.CLEANED,
            retentionLockedUntil: null,
            retentionLockToken: null,
            retentionDestructiveStartedAt: null,
            retentionAttempts: 0,
            retentionLastError: '',
            evidencePurgedAt: now,
            evidenceUnavailable: true,
          },
          $unset: {
            reporterId: '',
            encryptedContactEmail: '',
            contactEmailMasked: '',
            contactLookupHmac: '',
            encryptedAccountIdentifier: '',
            requestFingerprintHmac: '',
            description: '',
            descriptionHash: '',
            dedupeKey: '',
            adminNote: '',
          },
        },
      );
      return update.modifiedCount === 1 ? 'updated' : 'lost';
    } catch (error: unknown) {
      return this.releaseFailure(
        this.systemReports,
        claimed,
        token,
        now,
        error,
        true,
      );
    }
  }

  private async processOneSafeDelete<T extends Report | SystemReport>(
    model: Model<T>,
    now: Date,
    eligibilityFilter: Record<string, unknown>,
    terminalFilter: Record<string, unknown>,
  ): Promise<CleanupOutcome> {
    const token = randomUUID();
    const claimed = await this.claim(model, eligibilityFilter, token, now);
    if (!claimed) return 'none';

    try {
      const deletion = await model.deleteOne({
        _id: claimed._id,
        ...terminalFilter,
        ...this.notActivelyHeldFilter(now),
        retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
        retentionLockToken: token,
      });
      return deletion.deletedCount === 1 ? 'deleted' : 'lost';
    } catch (error: unknown) {
      return this.releaseFailure(model, claimed, token, now, error);
    }
  }

  private async claim<T extends Report | SystemReport>(
    model: Model<T>,
    filter: Record<string, unknown>,
    token: string,
    now: Date,
    extraSelection = '',
  ): Promise<ClaimedEvidence | null> {
    return model
      .findOneAndUpdate(
        filter,
        {
          $set: {
            retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
            retentionLockedUntil: new Date(now.getTime() + LOCK_MS),
            retentionLockToken: token,
            retentionLastError: '',
          },
          $inc: { retentionAttempts: 1 },
        },
        { sort: { terminalAt: 1, _id: 1 }, returnDocument: 'after' },
      )
      .select(`_id retentionAttempts ${extraSelection}`.trim())
      .lean<ClaimedEvidence>()
      .exec();
  }

  private async releaseFailure<T extends Report | SystemReport>(
    model: Model<T>,
    claimed: ClaimedEvidence,
    token: string,
    now: Date,
    error: unknown,
    destructiveStarted = false,
  ): Promise<CleanupOutcome> {
    const attempts = claimed.retentionAttempts ?? 1;
    const finalStatus =
      destructiveStarted || attempts >= MAX_ATTEMPTS
        ? RetentionCleanupStatus.MANUAL_REVIEW
        : RetentionCleanupStatus.FAILED;
    const message = error instanceof Error ? error.message : String(error);
    const release = await model.updateOne(
      {
        _id: claimed._id,
        retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
        retentionLockToken: token,
      },
      {
        $set: {
          retentionCleanupStatus: finalStatus,
          retentionLockedUntil:
            finalStatus === RetentionCleanupStatus.FAILED
              ? new Date(now.getTime() + RETRY_DELAY_MS)
              : null,
          retentionLockToken: null,
          retentionLastError: message.slice(0, 2000),
        },
      },
    );
    if (release.modifiedCount !== 1) return 'lost';
    return finalStatus === RetentionCleanupStatus.MANUAL_REVIEW
      ? 'manual_review'
      : 'failed';
  }

  private async reserveSystemReportDestruction(
    id: Types.ObjectId,
    token: string,
    now: Date,
  ): Promise<boolean> {
    const reservation = await this.systemReports.updateOne(
      {
        _id: id,
        ...this.systemPurgeTerminalFilter(now),
        ...this.notActivelyHeldFilter(now),
        retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
        retentionLockToken: token,
        retentionLockedUntil: { $gt: now },
        $and: [
          {
            $or: [
              { retentionDestructiveStartedAt: null },
              { retentionDestructiveStartedAt: { $exists: false } },
            ],
          },
        ],
      },
      {
        $set: {
          retentionDestructiveStartedAt: now,
          retentionLockedUntil: new Date(now.getTime() + LOCK_MS),
        },
      },
    );
    return reservation.modifiedCount === 1;
  }

  private purgeFilter(now: Date): Record<string, unknown> {
    return {
      ...this.purgeTerminalFilter(now),
      $and: [
        this.notActivelyHeldFilter(now),
        this.notPurgedFilter(),
        this.claimableStateFilter(now),
      ],
    };
  }

  private systemPurgeFilter(now: Date): Record<string, unknown> {
    return {
      ...this.systemPurgeTerminalFilter(now),
      $and: [
        this.notActivelyHeldFilter(now),
        this.notPurgedFilter(),
        this.noDestructiveReservationFilter(),
        this.claimableStateFilter(now),
      ],
    };
  }

  private safeReportDeleteFilter(now: Date): Record<string, unknown> {
    return {
      ...this.reportSafeDeleteTerminalFilter(now),
      evidencePurgedAt: { $type: 'date' },
      $and: [
        this.notActivelyHeldFilter(now),
        this.claimableStateFilter(now, true),
      ],
    };
  }

  private safeSystemReportDeleteFilter(now: Date): Record<string, unknown> {
    return {
      ...this.systemReportSafeDeleteTerminalFilter(now),
      evidencePurgedAt: { $type: 'date' },
      $and: [
        this.notActivelyHeldFilter(now),
        this.claimableStateFilter(now, true),
      ],
    };
  }

  private purgeTerminalFilter(now: Date): Record<string, unknown> {
    return {
      status: { $in: [ReportStatus.RESOLVED, ReportStatus.REJECTED] },
      terminalAt: { $lte: this.cutoff(now, EVIDENCE_GRACE_DAYS) },
    };
  }

  private systemPurgeTerminalFilter(now: Date): Record<string, unknown> {
    return {
      status: { $in: [SystemReportStatus.FIXED, SystemReportStatus.CLOSED] },
      terminalAt: { $lte: this.cutoff(now, EVIDENCE_GRACE_DAYS) },
    };
  }

  private reportSafeDeleteTerminalFilter(now: Date): Record<string, unknown> {
    return {
      status: { $in: [ReportStatus.RESOLVED, ReportStatus.REJECTED] },
      terminalAt: { $lte: this.cutoff(now, SAFE_METADATA_DAYS) },
    };
  }

  private systemReportSafeDeleteTerminalFilter(
    now: Date,
  ): Record<string, unknown> {
    return {
      status: { $in: [SystemReportStatus.FIXED, SystemReportStatus.CLOSED] },
      terminalAt: { $lte: this.cutoff(now, SAFE_METADATA_DAYS) },
    };
  }

  private notPurgedFilter(): Record<string, unknown> {
    return {
      $or: [
        { evidencePurgedAt: null },
        { evidencePurgedAt: { $exists: false } },
      ],
    };
  }

  private notActivelyHeldFilter(now: Date): Record<string, unknown> {
    return {
      $or: [
        { retentionHold: null },
        { retentionHold: { $exists: false } },
        { 'retentionHold.expiresAt': { $lte: now } },
      ],
    };
  }

  private noDestructiveReservationFilter(): Record<string, unknown> {
    return {
      $or: [
        { retentionDestructiveStartedAt: null },
        { retentionDestructiveStartedAt: { $exists: false } },
      ],
    };
  }

  private claimableStateFilter(
    now: Date,
    evidenceAlreadyPurged = false,
  ): Record<string, unknown> {
    const baseStates = evidenceAlreadyPurged
      ? [{ retentionCleanupStatus: RetentionCleanupStatus.CLEANED }]
      : [
          { retentionCleanupStatus: RetentionCleanupStatus.PENDING },
          { retentionCleanupStatus: { $exists: false } },
        ];
    return {
      $and: [
        {
          $or: [
            { retentionAttempts: { $lt: MAX_ATTEMPTS } },
            { retentionAttempts: { $exists: false } },
          ],
        },
        {
          $or: [
            ...baseStates,
            {
              retentionCleanupStatus: RetentionCleanupStatus.FAILED,
              retentionLockedUntil: { $lte: now },
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.FAILED,
              retentionLockedUntil: null,
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
              retentionLockedUntil: { $lte: now },
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
              retentionLockedUntil: null,
            },
          ],
        },
      ],
    };
  }

  private exhaustedFilter(
    now: Date,
    statuses: readonly (ReportStatus | SystemReportStatus)[],
  ): Record<string, unknown> {
    return {
      status: { $in: statuses },
      terminalAt: { $type: 'date' },
      $and: [
        this.notActivelyHeldFilter(now),
        {
          $or: [
            {
              retentionAttempts: { $gte: MAX_ATTEMPTS },
              $or: [
                { retentionCleanupStatus: RetentionCleanupStatus.FAILED },
                {
                  retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
                  retentionLockedUntil: { $lte: now },
                },
                {
                  retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
                  retentionLockedUntil: null,
                },
              ],
            },
            {
              retentionCleanupStatus: RetentionCleanupStatus.PROCESSING,
              retentionDestructiveStartedAt: { $type: 'date' },
              $or: [
                { retentionLockedUntil: { $lte: now } },
                { retentionLockedUntil: null },
              ],
            },
          ],
        },
      ],
    };
  }

  private async findIds<T extends Report | SystemReport>(
    model: Model<T>,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<Types.ObjectId[]> {
    if (limit === 0) return [];
    const records = await model
      .find(filter)
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return records.map(({ _id }) => _id);
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
  }

  private result(
    collection: string,
    eligible: number,
    planned: number,
    startedAt: number,
    values: Partial<CollectionCleanupResult> = {},
  ): CollectionCleanupResult {
    return {
      collection,
      eligible,
      planned,
      processed: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      lostOwnership: 0,
      manualReview: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      ...values,
    };
  }
}
