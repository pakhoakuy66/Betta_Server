import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import {
  CanonicalModerationReasonCode,
  MODERATION_REASON_TAXONOMY_VERSION,
  ModerationReasonAction,
  ModerationReasonTarget,
  PublicModerationReasonCode,
} from '../../../common/moderation/moderation-reason.constants';
import {
  getCanonicalModerationReason,
  normalizeModerationReasonDetail,
} from '../../../common/moderation/moderation-reason.policy';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { Report, ReportStatus } from '../../reports/schemas/report.schema';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_AUTHENTICATION_FAILED_MESSAGE,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN,
} from '../constants/admin-lifecycle.constants';
import {
  AdminPermission,
  hasAdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_REPORT_DECISION_AGGREGATE_TYPE,
  ADMIN_REPORT_DECISION_EVENT_TYPE,
  ADMIN_REPORT_DECISION_FAILURE_INJECTOR,
  ADMIN_REPORT_DECISION_IDEMPOTENCY_TTL_MS,
  ADMIN_REPORT_DECISION_REPLAY_WAIT_DELAYS_MS,
  ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH,
  ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH,
  AdminReportDecision,
  AdminReportDecisionFailureStep,
  AdminReportDecisionOutcome,
  AdminReportDecisionRequestState,
  AdminReportTargetAction,
  getAdminReportTargetPermission,
} from '../constants/admin-report-decision.constants';
import { ADMIN_REPORT_PUBLIC_ID_PATTERN } from '../constants/admin-report-assignment.constants';
import {
  AdminReportDecisionConflictException,
  AdminReportDecisionIdempotencyConflictException,
} from '../exceptions/admin-report-decision-conflict.exception';
import type {
  AdminReportDecisionActor,
  AdminReportDecisionFailureInjector,
  AdminReportDecisionMutationResult,
  UpdateAdminReportDecisionInput,
} from '../interfaces/admin-report-decision.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminReportDecisionRequest } from '../schemas/admin-report-decision-request.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { ModerationDecision } from '../schemas/moderation-decision.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { generateModerationDecisionPublicId } from '../utils/generate-moderation-decision-public-id';
import { AdminAuditService } from './admin-audit.service';
import {
  AdminReportTargetMutationService,
  type DecisionReport,
  type TargetMutationInput,
} from './admin-report-target-mutation.service';

const IDEMPOTENCY_DOMAIN = 'betta:admin-report-decision:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-report-decision:fingerprint:v1';
const REPORT_PROJECTION =
  '_id publicId reporterId targetType targetId targetSnapshot status ' +
  'assigneePublicId version';

type NormalizedInput = Omit<
  UpdateAdminReportDecisionInput,
  | 'reasonCode'
  | 'actionReasonCode'
  | 'reasonNote'
  | 'expiresAt'
  | 'correlationId'
> &
  Readonly<{
    reasonCode: CanonicalModerationReasonCode;
    actionReasonCode?: CanonicalModerationReasonCode;
    reasonNote: string;
    expiresAt?: Date;
    correlationId?: string;
  }>;

type StoredRequest = Readonly<{
  requestFingerprint: string;
  state: AdminReportDecisionRequestState;
  reportPublicId: string;
  targetAction: AdminReportTargetAction;
  resultDecisionPublicId: string | null;
  resultStatus: 'RESOLVED' | 'REJECTED' | null;
  resultOutcome: AdminReportDecisionOutcome | null;
  resultReportVersion: number | null;
  resultTargetVersion: number | null;
  resultTerminalAt: Date | null;
}>;

type CompletedStoredRequest = StoredRequest &
  Readonly<{
    state: AdminReportDecisionRequestState.COMPLETED;
    resultDecisionPublicId: string;
    resultStatus: 'RESOLVED' | 'REJECTED';
    resultOutcome: AdminReportDecisionOutcome;
    resultReportVersion: number;
    resultTerminalAt: Date;
  }>;

@Injectable()
export class AdminReportDecisionService {
  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(AdminAccount.name)
    private readonly adminAccounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessions: Model<AdminSession>,
    @InjectModel(ModerationDecision.name)
    private readonly histories: Model<ModerationDecision>,
    @InjectModel(AdminReportDecisionRequest.name)
    private readonly requests: Model<AdminReportDecisionRequest>,
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
    private readonly targets: AdminReportTargetMutationService,
    @Optional()
    @Inject(ADMIN_REPORT_DECISION_FAILURE_INJECTOR)
    private readonly failureInjector?: AdminReportDecisionFailureInjector,
  ) {}

  async update(
    input: UpdateAdminReportDecisionInput,
  ): Promise<AdminReportDecisionMutationResult> {
    const normalized = this.normalize(input);
    const replay = await this.loadReplay(normalized);
    if (replay) return replay;

    try {
      return await this.connection.transaction(async (session) => {
        await this.assertActorStillEligible(normalized.actor, session);
        const now = new Date();
        await this.reserveRequest(normalized, now, session);
        const report = await this.reports
          .findOne({ publicId: normalized.reportPublicId })
          .select(REPORT_PROJECTION)
          .session(session)
          .lean<
            | (DecisionReport & {
                status: ReportStatus;
                assigneePublicId: string | null;
              })
            | null
          >()
          .exec();
        if (!report) throw new NotFoundException('Không tìm thấy report');
        this.assertReport(report, normalized);

        const targetInput = this.targetInput(normalized);
        const inspected = await this.targets.inspect(report, now, session);
        const outcome = this.targets.outcome(targetInput, inspected);
        const applied =
          outcome === AdminReportDecisionOutcome.ACTION_APPLIED
            ? await this.targets.apply(
                report,
                inspected,
                targetInput,
                now,
                session,
              )
            : undefined;
        await this.hit(AdminReportDecisionFailureStep.AFTER_TARGET);

        const nextStatus =
          normalized.decision === AdminReportDecision.RESOLVE
            ? ReportStatus.RESOLVED
            : ReportStatus.REJECTED;
        const updated = await this.reports
          .findOneAndUpdate(
            {
              _id: report._id,
              publicId: report.publicId,
              status: ReportStatus.REVIEWING,
              assigneePublicId: normalized.actor.publicId,
              version: normalized.expectedReportVersion,
              terminalAt: null,
            },
            {
              $set: {
                status: nextStatus,
                terminalAt: now,
                adminNote: normalized.reasonNote,
              },
              $inc: { version: 1 },
            },
            {
              session,
              returnDocument: 'after',
              runValidators: true,
            },
          )
          .select('_id publicId status version terminalAt')
          .lean<{
            _id: Types.ObjectId;
            publicId: string;
            status: ReportStatus;
            version: number;
            terminalAt: Date;
          } | null>()
          .exec();
        if (!updated) throw this.staleConflict();
        await this.hit(AdminReportDecisionFailureStep.AFTER_REPORT);

        const decisionPublicId = generateModerationDecisionPublicId();
        await this.histories.create(
          [
            {
              publicId: decisionPublicId,
              reportId: report._id,
              reportPublicId: report.publicId,
              targetId: report.targetId,
              targetPublicId: inspected.publicId,
              targetType: report.targetType,
              decision: normalized.decision,
              targetAction: normalized.targetAction,
              outcome,
              reasonCode: normalized.reasonCode,
              actionReasonCode: normalized.actionReasonCode ?? null,
              reasonTaxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
              reasonNote: normalized.reasonNote,
              actorPublicId: normalized.actor.publicId,
              actorRole: normalized.actor.role,
              reportBeforeVersion: report.version,
              reportAfterVersion: updated.version,
              targetBeforeVersion: applied?.beforeVersion ?? null,
              targetAfterVersion: applied?.afterVersion ?? null,
              terminalAt: now,
              correlationId: normalized.correlationId ?? null,
            },
          ],
          { session },
        );
        await this.hit(AdminReportDecisionFailureStep.AFTER_HISTORY);

        if (applied) {
          await this.targets.recordAudit(report, applied, targetInput, session);
        }
        await this.recordReportAudit(
          report,
          normalized,
          nextStatus,
          updated.version,
          session,
        );
        await this.hit(AdminReportDecisionFailureStep.AFTER_AUDIT);

        await this.enqueueDecision(
          report,
          inspected.publicId,
          normalized,
          outcome,
          updated.version,
          now,
          session,
        );
        if (applied) {
          await this.targets.enqueue(report, applied, targetInput, session);
        }
        await this.hit(AdminReportDecisionFailureStep.AFTER_OUTBOX);

        await this.completeRequest(
          normalized,
          {
            decisionPublicId,
            status:
              normalized.decision === AdminReportDecision.RESOLVE
                ? 'RESOLVED'
                : 'REJECTED',
            outcome,
            reportVersion: updated.version,
            targetVersion: applied?.afterVersion ?? null,
            terminalAt: now,
          },
          session,
        );
        await this.hit(AdminReportDecisionFailureStep.AFTER_REQUEST);

        return this.toResult({
          reportPublicId: report.publicId,
          decisionPublicId,
          status:
            normalized.decision === AdminReportDecision.RESOLVE
              ? 'RESOLVED'
              : 'REJECTED',
          reportVersion: updated.version,
          targetAction: normalized.targetAction,
          outcome,
          targetVersion: applied?.afterVersion ?? null,
          terminalAt: now,
        });
      });
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) {
        const duplicateReplay =
          await this.loadReplayAfterConcurrentCommit(normalized);
        if (duplicateReplay) return duplicateReplay;
      }
      this.rethrow(error);
    }
  }

  private async reserveRequest(
    input: NormalizedInput,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.requests.insertMany(
      [
        {
          idempotencyHash: this.idempotencyHash(input),
          requestFingerprint: this.requestFingerprint(input),
          actorPublicId: input.actor.publicId,
          actorSessionPublicId: input.actor.sessionPublicId,
          reportPublicId: input.reportPublicId,
          decision: input.decision,
          targetAction: input.targetAction,
          state: AdminReportDecisionRequestState.PENDING,
          idempotencyExpiresAt: new Date(
            now.getTime() + ADMIN_REPORT_DECISION_IDEMPOTENCY_TTL_MS,
          ),
        },
      ],
      { session },
    );
  }

  private async completeRequest(
    input: NormalizedInput,
    result: Readonly<{
      decisionPublicId: string;
      status: 'RESOLVED' | 'REJECTED';
      outcome: AdminReportDecisionOutcome;
      reportVersion: number;
      targetVersion: number | null;
      terminalAt: Date;
    }>,
    session: ClientSession,
  ): Promise<void> {
    const completion = await this.requests.updateOne(
      {
        idempotencyHash: this.idempotencyHash(input),
        requestFingerprint: this.requestFingerprint(input),
        state: AdminReportDecisionRequestState.PENDING,
      },
      {
        $set: {
          state: AdminReportDecisionRequestState.COMPLETED,
          resultDecisionPublicId: result.decisionPublicId,
          resultStatus: result.status,
          resultOutcome: result.outcome,
          resultReportVersion: result.reportVersion,
          resultTargetVersion: result.targetVersion,
          resultTerminalAt: result.terminalAt,
        },
      },
      { session, runValidators: true },
    );
    if (completion.matchedCount !== 1 || completion.modifiedCount !== 1) {
      throw new Error('REPORT_DECISION_IDEMPOTENCY_COMPLETION_FAILED');
    }
  }
  private normalize(input: UpdateAdminReportDecisionInput): NormalizedInput {
    this.assertActor(input.actor);
    const note = normalizeModerationReasonDetail(
      input.reasonNote,
      ADMIN_REPORT_DECISION_NOTE_MIN_LENGTH,
      ADMIN_REPORT_DECISION_NOTE_MAX_LENGTH,
    );
    const correlationId = input.correlationId?.trim();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    const reasonCode =
      input.reasonCode?.trim() as CanonicalModerationReasonCode;
    const actionReasonCode = input.actionReasonCode?.trim() as
      | CanonicalModerationReasonCode
      | undefined;

    if (
      !ADMIN_REPORT_PUBLIC_ID_PATTERN.test(input.reportPublicId) ||
      !Number.isSafeInteger(input.expectedReportVersion) ||
      input.expectedReportVersion < 0 ||
      !ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      !note ||
      (input.expectedTargetVersion !== undefined &&
        (!Number.isSafeInteger(input.expectedTargetVersion) ||
          input.expectedTargetVersion < 0)) ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId)) ||
      (expiresAt !== undefined && Number.isNaN(expiresAt.getTime()))
    ) {
      throw new BadRequestException('Report decision input không hợp lệ');
    }

    if (input.decision === AdminReportDecision.REJECT) {
      if (
        input.targetAction !== AdminReportTargetAction.NONE ||
        reasonCode !== CanonicalModerationReasonCode.INSUFFICIENT_EVIDENCE ||
        input.expectedTargetVersion !== undefined ||
        input.actionReasonCode !== undefined ||
        input.publicReasonCode !== undefined ||
        input.expiresAt !== undefined ||
        !getCanonicalModerationReason(
          ModerationReasonTarget.REPORT,
          ModerationReasonAction.REJECT,
          reasonCode,
        )
      ) {
        throw new BadRequestException('Reject report không được đổi target');
      }
    } else if (input.decision === AdminReportDecision.RESOLVE) {
      if (input.targetAction === AdminReportTargetAction.NONE) {
        if (
          !getCanonicalModerationReason(
            ModerationReasonTarget.REPORT,
            ModerationReasonAction.CLOSE_NO_ACTION,
            reasonCode,
          ) ||
          input.expectedTargetVersion !== undefined ||
          input.actionReasonCode !== undefined ||
          input.publicReasonCode !== undefined ||
          input.expiresAt !== undefined
        ) {
          throw new BadRequestException(
            'Resolve no-action chỉ dành cho target không khả dụng',
          );
        }
      } else {
        if (
          reasonCode !== CanonicalModerationReasonCode.EVIDENCE_CONFIRMED ||
          !getCanonicalModerationReason(
            ModerationReasonTarget.REPORT,
            ModerationReasonAction.RESOLVE,
            reasonCode,
          ) ||
          input.expectedTargetVersion === undefined
        ) {
          throw new BadRequestException(
            'Resolve action yêu cầu target version và evidence_confirmed',
          );
        }
        this.assertActionContract(input, actionReasonCode, expiresAt);
      }
    } else {
      throw new BadRequestException('Report decision không hợp lệ');
    }

    return Object.freeze({
      ...input,
      reasonCode,
      actionReasonCode,
      reasonNote: note,
      expiresAt,
      correlationId,
    });
  }

  private assertActionContract(
    input: UpdateAdminReportDecisionInput,
    actionReasonCode: CanonicalModerationReasonCode | undefined,
    expiresAt: Date | undefined,
  ): void {
    const permission = getAdminReportTargetPermission(input.targetAction);
    if (!permission || !hasAdminPermission(input.actor.role, permission)) {
      throw new ForbiddenException('Admin không có quyền action trên target');
    }

    const isPost =
      input.targetAction === AdminReportTargetAction.POST_HIDE ||
      input.targetAction === AdminReportTargetAction.POST_TERMINAL_DELETE;
    const isSuspend =
      input.targetAction === AdminReportTargetAction.USER_TEMPORARY_SUSPENSION;
    const expectedReason =
      input.targetAction === AdminReportTargetAction.POST_HIDE || isSuspend
        ? CanonicalModerationReasonCode.MODERATION_POLICY
        : CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION;
    const expectedPublic = isPost
      ? PublicModerationReasonCode.CONTENT_VISIBILITY_UPDATED
      : isSuspend
        ? PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW
        : PublicModerationReasonCode.SEVERE_POLICY_VIOLATION;
    if (
      actionReasonCode !== expectedReason ||
      input.publicReasonCode !== expectedPublic ||
      (isSuspend ? !expiresAt : input.expiresAt !== undefined)
    ) {
      throw new BadRequestException('Target action reason không hợp lệ');
    }

    const action =
      input.targetAction === AdminReportTargetAction.POST_HIDE
        ? ModerationReasonAction.HIDE
        : input.targetAction === AdminReportTargetAction.POST_TERMINAL_DELETE
          ? ModerationReasonAction.TERMINAL_DELETE
          : isSuspend
            ? ModerationReasonAction.APPLY_TEMPORARY_SUSPENSION
            : ModerationReasonAction.APPLY_INDEFINITE_BAN;
    const target = isPost
      ? ModerationReasonTarget.POST
      : ModerationReasonTarget.USER_RESTRICTION;
    if (!getCanonicalModerationReason(target, action, actionReasonCode)) {
      throw new BadRequestException('Target action reason không hợp lệ');
    }
  }

  private assertReport(
    report: DecisionReport & {
      status: ReportStatus;
      assigneePublicId: string | null;
    },
    input: NormalizedInput,
  ): void {
    if (
      report.status !== ReportStatus.REVIEWING ||
      report.assigneePublicId !== input.actor.publicId ||
      report.version !== input.expectedReportVersion
    ) {
      throw this.staleConflict();
    }
  }

  private targetInput(input: NormalizedInput): TargetMutationInput {
    return Object.freeze({
      actor: input.actor,
      decision: input.decision,
      targetAction: input.targetAction,
      expectedTargetVersion: input.expectedTargetVersion,
      reasonCode: input.reasonCode,
      actionReasonCode: input.actionReasonCode,
      publicReasonCode: input.publicReasonCode,
      expiresAt: input.expiresAt,
      reasonNote: input.reasonNote,
      correlationId: input.correlationId,
    });
  }

  private async recordReportAudit(
    report: DecisionReport,
    input: NormalizedInput,
    nextStatus: ReportStatus,
    afterVersion: number,
    session: ClientSession,
  ): Promise<void> {
    await this.audit.record({
      action:
        input.decision === AdminReportDecision.RESOLVE
          ? AdminAuditAction.REPORT_RESOLVED
          : AdminAuditAction.REPORT_REJECTED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: input.actor,
      target: {
        type: AdminAuditTargetType.REPORT,
        publicId: report.publicId,
      },
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote,
      metadata: {
        beforeVersion: report.version,
        afterVersion,
        beforeState: ReportStatus.REVIEWING,
        afterState: nextStatus,
      },
      correlationId: input.correlationId,
      source: AdminAuditSource.HTTP,
      mongoSession: session,
    });
  }

  private async enqueueDecision(
    report: DecisionReport,
    targetPublicId: string,
    input: NormalizedInput,
    outcome: AdminReportDecisionOutcome,
    reportVersion: number,
    terminalAt: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.outbox.enqueue({
      eventType: ADMIN_REPORT_DECISION_EVENT_TYPE,
      dedupeKey: `report-decision:${report.publicId}:${reportVersion}`,
      aggregateType: ADMIN_REPORT_DECISION_AGGREGATE_TYPE,
      aggregatePublicId: report.publicId,
      payload: {
        schemaVersion: 1,
        reportPublicId: report.publicId,
        decision: input.decision,
        targetAction: input.targetAction,
        outcome,
        targetType: report.targetType,
        targetPublicId,
        terminalAt: terminalAt.toISOString(),
        reportVersion,
      },
      correlationId: input.correlationId,
      mongoSession: session,
    });
  }

  private async assertActorStillEligible(
    actor: AdminReportDecisionActor,
    session: ClientSession,
  ): Promise<void> {
    const [account, activeSession] = await Promise.all([
      this.adminAccounts
        .exists({
          _id: actor.adminAccountId,
          publicId: actor.publicId,
          role: actor.role,
          status: AdminAccountStatus.ACTIVE,
          mfaStatus: AdminMfaStatus.ACTIVE,
          mustChangePassword: false,
          credentialVersion: actor.credentialVersion,
          authzVersion: actor.authzVersion,
          permissionVersion: actor.permissionVersion,
          deletedAt: null,
        })
        .session(session),
      this.adminSessions
        .exists({
          adminAccountId: actor.adminAccountId,
          adminPublicId: actor.publicId,
          publicId: actor.sessionPublicId,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        })
        .session(session),
    ]);
    if (!account || !activeSession) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
  }

  private assertActor(actor: AdminReportDecisionActor): void {
    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      (actor.role !== AdminRole.ADMIN &&
        actor.role !== AdminRole.SUPER_ADMIN) ||
      actor.permission !== AdminPermission.REPORTS_RESOLVE ||
      !hasAdminPermission(actor.role, actor.permission) ||
      !(actor.adminAccountId instanceof Types.ObjectId) ||
      !isValidAdminPublicId(actor.publicId) ||
      !actor.username ||
      !actor.displayName ||
      !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(actor.sessionPublicId) ||
      !Number.isSafeInteger(actor.credentialVersion) ||
      actor.credentialVersion < 0 ||
      !Number.isSafeInteger(actor.authzVersion) ||
      actor.authzVersion < 0 ||
      !Number.isSafeInteger(actor.permissionVersion) ||
      actor.permissionVersion < 1
    ) {
      throw new ForbiddenException('Admin không có quyền quyết định report');
    }
  }

  private async loadReplay(
    input: NormalizedInput,
  ): Promise<AdminReportDecisionMutationResult | undefined> {
    try {
      const stored = await this.requests
        .findOne({
          idempotencyHash: this.idempotencyHash(input),
        })
        .select('+requestFingerprint')
        .lean<StoredRequest | null>()
        .exec();
      if (!stored) return undefined;
      if (stored.requestFingerprint !== this.requestFingerprint(input)) {
        throw new AdminReportDecisionIdempotencyConflictException();
      }
      if (
        stored.state !== AdminReportDecisionRequestState.COMPLETED ||
        stored.resultDecisionPublicId === null ||
        stored.resultStatus === null ||
        stored.resultOutcome === null ||
        stored.resultReportVersion === null ||
        stored.resultTerminalAt === null
      ) {
        return undefined;
      }
      return this.storedResult(stored as CompletedStoredRequest);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private async loadReplayAfterConcurrentCommit(
    input: NormalizedInput,
  ): Promise<AdminReportDecisionMutationResult | undefined> {
    const immediate = await this.loadReplay(input);
    if (immediate) return immediate;
    for (const delayMs of ADMIN_REPORT_DECISION_REPLAY_WAIT_DELAYS_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const replay = await this.loadReplay(input);
      if (replay) return replay;
    }
    return undefined;
  }

  private storedResult(
    stored: CompletedStoredRequest,
  ): AdminReportDecisionMutationResult {
    return this.toResult({
      reportPublicId: stored.reportPublicId,
      decisionPublicId: stored.resultDecisionPublicId,
      status: stored.resultStatus,
      reportVersion: stored.resultReportVersion,
      targetAction: stored.targetAction,
      outcome: stored.resultOutcome,
      targetVersion: stored.resultTargetVersion,
      terminalAt: stored.resultTerminalAt,
    });
  }

  private toResult(input: {
    reportPublicId: string;
    decisionPublicId: string;
    status: 'RESOLVED' | 'REJECTED';
    reportVersion: number;
    targetAction: AdminReportTargetAction;
    outcome: AdminReportDecisionOutcome;
    targetVersion: number | null;
    terminalAt: Date;
  }): AdminReportDecisionMutationResult {
    return Object.freeze({
      report: Object.freeze({
        id: input.reportPublicId,
        publicId: input.reportPublicId,
        status: input.status,
        version: input.reportVersion,
        terminalAt: input.terminalAt.toISOString(),
      }),
      decision: Object.freeze({
        id: input.decisionPublicId,
        publicId: input.decisionPublicId,
        targetAction: input.targetAction,
        outcome: input.outcome,
        targetVersion: input.targetVersion,
      }),
    });
  }

  private idempotencyHash(input: NormalizedInput): string {
    return this.hash([
      IDEMPOTENCY_DOMAIN,
      input.actor.publicId,
      input.idempotencyKey,
    ]);
  }

  private requestFingerprint(input: NormalizedInput): string {
    return this.hash([
      FINGERPRINT_DOMAIN,
      input.reportPublicId,
      input.decision,
      input.targetAction,
      String(input.expectedReportVersion),
      String(input.expectedTargetVersion ?? ''),
      input.reasonCode,
      input.actionReasonCode ?? '',
      input.publicReasonCode ?? '',
      input.expiresAt?.toISOString() ?? '',
      input.reasonNote,
      input.correlationId ?? '',
    ]);
  }

  private hash(parts: readonly string[]): string {
    return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
  }

  private async hit(step: AdminReportDecisionFailureStep): Promise<void> {
    await this.failureInjector?.hit(step);
  }

  private staleConflict(): AdminReportDecisionConflictException {
    return new AdminReportDecisionConflictException(
      'Report đã được cập nhật, đổi assignee hoặc không còn REVIEWING',
    );
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      Number(error.code) === 11000
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Report decision tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
