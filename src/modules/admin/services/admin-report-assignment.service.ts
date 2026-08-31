import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
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
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/report-queue.constants';
import { Report, ReportStatus } from '../../reports/schemas/report.schema';
import {
  RetentionCleanupStatus,
  SystemReport,
  SystemReportStatus,
} from '../../reports/schemas/system-report.schema';
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
  AdminReportQueueStatus,
  REPORT_STATUS_TO_ADMIN,
  SYSTEM_REPORT_STATUS_TO_ADMIN,
} from '../constants/admin-report-queue.constants';
import {
  AdminPermission,
  hasAdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_TTL_MS,
  ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH,
  ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH,
  ADMIN_REPORT_ASSIGNMENT_REPLAY_WAIT_DELAYS_MS,
  ADMIN_REPORT_CLAIM_REASON_CODE,
  ADMIN_REPORT_PUBLIC_ID_PATTERN,
  ADMIN_REPORT_REASSIGN_REASON_CODE,
  AdminReportAssignmentKind,
  AdminReportAssignmentOperation,
  AdminReportAssignmentRequestState,
} from '../constants/admin-report-assignment.constants';
import type {
  AdminReportAssignmentActor,
  AdminReportAssignmentCurrentState,
  AdminReportAssignmentMutationResult,
  UpdateAdminReportAssignmentInput,
} from '../interfaces/admin-report-assignment.interface';
import {
  AdminReportAssignmentConflictException,
  AdminReportAssignmentIdempotencyConflictException,
} from '../exceptions/admin-report-assignment-conflict.exception';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminReportAssignmentRequest } from '../schemas/admin-report-assignment-request.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';

const IDEMPOTENCY_DOMAIN = 'betta:admin-report-assignment:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-report-assignment:fingerprint:v1';
const SENSITIVE_NOTE_PATTERN =
  /authorization|bearer|cookie|mật khẩu|password|otp|refresh.?token|access.?token|secret|recovery.?code/i;

const containsUnsafeControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });

type StoredAssignment = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  status: ReportStatus | SystemReportStatus;
  assigneePublicId: string | null;
  assignedAt: Date | null;
  version: number;
  updatedAt: Date;
  retentionCleanupStatus?: RetentionCleanupStatus;
}>;

type AssignmentTarget = StoredAssignment &
  Readonly<{ kind: AdminReportAssignmentKind }>;

type StoredRequest = Readonly<{
  requestFingerprint: string;
  state: AdminReportAssignmentRequestState;
  targetPublicId: string;
  resultKind: AdminReportAssignmentKind;
  resultStatus: AdminReportQueueStatus | null;
  resultAssigneePublicId: string | null;
  resultAssignedAt: Date | null;
  resultVersion: number | null;
  resultUpdatedAt: Date | null;
}>;

type CompletedStoredRequest = StoredRequest &
  Readonly<{
    state: AdminReportAssignmentRequestState.COMPLETED;
    resultStatus: AdminReportQueueStatus;
    resultAssigneePublicId: string;
    resultAssignedAt: Date;
    resultVersion: number;
    resultUpdatedAt: Date;
  }>;

class AssignmentCasMissError extends Error {
  constructor() {
    super('REPORT_ASSIGNMENT_CAS_MISS');
  }
}

type NormalizedInput = Omit<
  UpdateAdminReportAssignmentInput,
  'assigneePublicId' | 'adminNote' | 'correlationId'
> &
  Readonly<{
    assigneePublicId?: string;
    adminNote?: string;
    correlationId?: string;
  }>;

const TARGET_PROJECTION =
  '_id publicId status assigneePublicId assignedAt version updatedAt ' +
  'retentionCleanupStatus';

@Injectable()
export class AdminReportAssignmentService {
  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(SystemReport.name)
    private readonly systemReports: Model<SystemReport>,
    @InjectModel(AdminAccount.name)
    private readonly adminAccounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessions: Model<AdminSession>,
    @InjectModel(AdminReportAssignmentRequest.name)
    private readonly requests: Model<AdminReportAssignmentRequest>,
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AdminAuditService,
  ) {}

  async update(
    input: UpdateAdminReportAssignmentInput,
  ): Promise<AdminReportAssignmentMutationResult> {
    const normalized = this.normalize(input);
    const replay = await this.loadReplay(normalized);
    if (replay) return replay;

    const snapshot = await this.loadTarget(normalized.reportPublicId);
    if (!snapshot) throw new NotFoundException('Không tìm thấy report');
    this.assertTransition(snapshot, normalized);

    const assigneePublicId =
      normalized.operation === AdminReportAssignmentOperation.CLAIM
        ? normalized.actor.publicId
        : (normalized.assigneePublicId as string);
    const assignedAt = new Date();

    try {
      return await this.connection.transaction(async (mongoSession) => {
        await this.assertActorStillEligible(normalized.actor, mongoSession);
        if (normalized.operation === AdminReportAssignmentOperation.REASSIGN) {
          await this.assertAssigneeEligible(assigneePublicId, mongoSession);
        }

        await this.reserveRequest(
          snapshot,
          normalized,
          assignedAt,
          mongoSession,
        );

        const updated = await this.casUpdate(
          snapshot,
          normalized,
          assigneePublicId,
          assignedAt,
          mongoSession,
        );
        if (!updated) throw new AssignmentCasMissError();

        await this.audit.record({
          action: this.auditAction(snapshot.kind, normalized.operation),
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: normalized.actor,
          target: {
            type:
              snapshot.kind === AdminReportAssignmentKind.REPORT
                ? AdminAuditTargetType.REPORT
                : AdminAuditTargetType.SYSTEM_REPORT,
            publicId: updated.publicId,
          },
          reasonCode:
            normalized.operation === AdminReportAssignmentOperation.CLAIM
              ? ADMIN_REPORT_CLAIM_REASON_CODE
              : ADMIN_REPORT_REASSIGN_REASON_CODE,
          reasonNote: normalized.adminNote,
          metadata: {
            beforeVersion: snapshot.version,
            afterVersion: updated.version,
            beforeState: snapshot.status,
            afterState: updated.status,
            beforeAssigneePublicId: snapshot.assigneePublicId ?? undefined,
            afterAssigneePublicId: updated.assigneePublicId ?? undefined,
          },
          correlationId: normalized.correlationId,
          source: AdminAuditSource.HTTP,
          mongoSession,
        });

        await this.completeRequest(
          snapshot.kind,
          normalized,
          updated,
          mongoSession,
        );

        return this.toResult(snapshot.kind, updated);
      });
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) {
        const duplicateReplay =
          await this.loadReplayAfterConcurrentCommit(normalized);
        if (duplicateReplay) return duplicateReplay;
      }

      if (error instanceof AssignmentCasMissError) {
        const current = await this.loadTarget(normalized.reportPublicId);
        if (!current) throw new NotFoundException('Không tìm thấy report');
        throw this.assignmentConflict(
          current,
          'Report đã được cập nhật bởi yêu cầu khác',
        );
      }

      this.rethrow(error);
    }
  }
  private normalize(input: UpdateAdminReportAssignmentInput): NormalizedInput {
    this.assertActor(input.actor);
    const assigneePublicId = input.assigneePublicId?.trim();
    const adminNote = input.adminNote?.trim();
    const correlationId = input.correlationId?.trim();

    if (
      !ADMIN_REPORT_PUBLIC_ID_PATTERN.test(input.reportPublicId) ||
      !Object.values(AdminReportAssignmentOperation).includes(
        input.operation,
      ) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      (correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(correlationId))
    ) {
      throw new BadRequestException('Report assignment input không hợp lệ');
    }

    if (
      adminNote !== undefined &&
      (adminNote.length < ADMIN_REPORT_ASSIGNMENT_NOTE_MIN_LENGTH ||
        adminNote.length > ADMIN_REPORT_ASSIGNMENT_NOTE_MAX_LENGTH ||
        containsUnsafeControlCharacter(adminNote) ||
        SENSITIVE_NOTE_PATTERN.test(adminNote))
    ) {
      throw new BadRequestException('Admin note không hợp lệ');
    }

    if (input.operation === AdminReportAssignmentOperation.CLAIM) {
      if (input.assigneePublicId !== undefined) {
        throw new BadRequestException('CLAIM không nhận assigneePublicId');
      }
    } else {
      if (input.actor.role !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Chỉ SuperAdmin được chuyển người xử lý report',
        );
      }
      if (
        !assigneePublicId ||
        !isValidAdminPublicId(assigneePublicId) ||
        !adminNote
      ) {
        throw new BadRequestException('REASSIGN input không hợp lệ');
      }
    }

    return Object.freeze({
      ...input,
      assigneePublicId,
      adminNote,
      correlationId,
    });
  }

  private async loadTarget(publicId: string): Promise<AssignmentTarget | null> {
    try {
      if (REPORT_PUBLIC_ID_PATTERN.test(publicId)) {
        const report = await this.reports
          .findOne({ publicId })
          .select(TARGET_PROJECTION)
          .lean<StoredAssignment | null>()
          .exec();
        return report
          ? Object.freeze({
              ...report,
              kind: AdminReportAssignmentKind.REPORT,
            })
          : null;
      }

      const systemReport = await this.systemReports
        .findOne({ publicId })
        .select(TARGET_PROJECTION)
        .lean<StoredAssignment | null>()
        .exec();
      return systemReport
        ? Object.freeze({
            ...systemReport,
            kind: AdminReportAssignmentKind.SYSTEM_REPORT,
          })
        : null;
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private assertTransition(
    target: AssignmentTarget,
    input: NormalizedInput,
  ): void {
    if (target.version !== input.expectedVersion) {
      throw this.assignmentConflict(
        target,
        'Report đã được cập nhật bởi yêu cầu khác',
      );
    }

    if (
      target.kind === AdminReportAssignmentKind.SYSTEM_REPORT &&
      target.retentionCleanupStatus !== undefined &&
      target.retentionCleanupStatus !== RetentionCleanupStatus.PENDING
    ) {
      throw this.assignmentConflict(
        target,
        'System report đang được retention xử lý',
      );
    }

    if (input.operation === AdminReportAssignmentOperation.CLAIM) {
      const expectedStatus =
        target.kind === AdminReportAssignmentKind.REPORT
          ? ReportStatus.PENDING
          : SystemReportStatus.PENDING;
      if (target.status !== expectedStatus || target.assigneePublicId) {
        throw this.assignmentConflict(target, 'Report đã được nhận xử lý');
      }
      return;
    }

    const expectedStatus =
      target.kind === AdminReportAssignmentKind.REPORT
        ? ReportStatus.REVIEWING
        : SystemReportStatus.INVESTIGATING;
    if (!target.assigneePublicId || target.status !== expectedStatus) {
      throw this.assignmentConflict(
        target,
        'Report chưa ở trạng thái đang xử lý',
      );
    }
    if (target.assigneePublicId === input.assigneePublicId) {
      throw this.assignmentConflict(target, 'Report đã thuộc người xử lý này');
    }
  }
  private async reserveRequest(
    target: AssignmentTarget,
    input: NormalizedInput,
    startedAt: Date,
    mongoSession: ClientSession,
  ): Promise<void> {
    await this.requests.insertMany(
      [
        {
          idempotencyHash: this.idempotencyHash(input),
          requestFingerprint: this.requestFingerprint(input),
          actorPublicId: input.actor.publicId,
          actorSessionPublicId: input.actor.sessionPublicId,
          targetReportId: target._id,
          targetPublicId: target.publicId,
          operation: input.operation,
          state: AdminReportAssignmentRequestState.PENDING,
          resultKind: target.kind,
          idempotencyExpiresAt: new Date(
            startedAt.getTime() + ADMIN_REPORT_ASSIGNMENT_IDEMPOTENCY_TTL_MS,
          ),
        },
      ],
      { session: mongoSession },
    );
  }

  private async completeRequest(
    kind: AdminReportAssignmentKind,
    input: NormalizedInput,
    updated: StoredAssignment,
    mongoSession: ClientSession,
  ): Promise<void> {
    const completion = await this.requests.updateOne(
      {
        idempotencyHash: this.idempotencyHash(input),
        requestFingerprint: this.requestFingerprint(input),
        state: AdminReportAssignmentRequestState.PENDING,
      },
      {
        $set: {
          state: AdminReportAssignmentRequestState.COMPLETED,
          resultStatus: this.publicStatus(kind, updated.status),
          resultAssigneePublicId: updated.assigneePublicId,
          resultAssignedAt: updated.assignedAt,
          resultVersion: updated.version,
          resultUpdatedAt: updated.updatedAt,
        },
      },
      { session: mongoSession, runValidators: true },
    );

    if (completion.matchedCount !== 1 || completion.modifiedCount !== 1) {
      throw new Error('REPORT_ASSIGNMENT_IDEMPOTENCY_COMPLETION_FAILED');
    }
  }
  private async casUpdate(
    target: AssignmentTarget,
    input: NormalizedInput,
    assigneePublicId: string,
    assignedAt: Date,
    mongoSession: ClientSession,
  ): Promise<StoredAssignment | null> {
    const isClaim = input.operation === AdminReportAssignmentOperation.CLAIM;
    const currentStatus =
      target.kind === AdminReportAssignmentKind.REPORT
        ? isClaim
          ? ReportStatus.PENDING
          : ReportStatus.REVIEWING
        : isClaim
          ? SystemReportStatus.PENDING
          : SystemReportStatus.INVESTIGATING;
    const nextStatus =
      target.kind === AdminReportAssignmentKind.REPORT
        ? ReportStatus.REVIEWING
        : SystemReportStatus.INVESTIGATING;
    const filter: Record<string, unknown> = {
      _id: target._id,
      publicId: target.publicId,
      version: input.expectedVersion,
      status: currentStatus,
      ...(isClaim
        ? {
            $or: [
              { assigneePublicId: null },
              { assigneePublicId: { $exists: false } },
            ],
          }
        : { assigneePublicId: target.assigneePublicId }),
    };
    if (target.kind === AdminReportAssignmentKind.SYSTEM_REPORT) {
      filter.$and = [
        {
          $or: [
            { retentionCleanupStatus: RetentionCleanupStatus.PENDING },
            { retentionCleanupStatus: { $exists: false } },
          ],
        },
      ];
    }

    const update = {
      $set: {
        status: nextStatus,
        assigneePublicId,
        assignedAt,
      },
      $inc: { version: 1 },
    };
    if (target.kind === AdminReportAssignmentKind.REPORT) {
      return await this.reports
        .findOneAndUpdate(filter as never, update as never, {
          session: mongoSession,
          returnDocument: 'after',
          runValidators: true,
        })
        .select(TARGET_PROJECTION)
        .lean<StoredAssignment | null>()
        .exec();
    }

    return await this.systemReports
      .findOneAndUpdate(filter as never, update as never, {
        session: mongoSession,
        returnDocument: 'after',
        runValidators: true,
      })
      .select(TARGET_PROJECTION)
      .lean<StoredAssignment | null>()
      .exec();
  }

  private async assertActorStillEligible(
    actor: AdminReportAssignmentActor,
    mongoSession: ClientSession,
  ): Promise<void> {
    const [accountExists, sessionExists] = await Promise.all([
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
        .session(mongoSession),
      this.adminSessions
        .exists({
          adminAccountId: actor.adminAccountId,
          adminPublicId: actor.publicId,
          publicId: actor.sessionPublicId,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        })
        .session(mongoSession),
    ]);
    if (!accountExists || !sessionExists) {
      throw new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    }
  }

  private async assertAssigneeEligible(
    assigneePublicId: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    const exists = await this.adminAccounts
      .exists({
        publicId: assigneePublicId,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        deletedAt: null,
      })
      .session(mongoSession);
    if (!exists) {
      throw new ConflictException('Admin nhận xử lý không còn khả dụng');
    }
  }

  private assertActor(actor: AdminReportAssignmentActor): void {
    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      (actor.role !== AdminRole.ADMIN &&
        actor.role !== AdminRole.SUPER_ADMIN) ||
      actor.permission !== AdminPermission.REPORTS_REVIEW ||
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
      throw new ForbiddenException('Admin không có quyền xử lý report');
    }
  }

  private auditAction(
    kind: AdminReportAssignmentKind,
    operation: AdminReportAssignmentOperation,
  ): AdminAuditAction {
    if (kind === AdminReportAssignmentKind.SYSTEM_REPORT) {
      return AdminAuditAction.SYSTEM_REPORT_TRANSITIONED;
    }
    return operation === AdminReportAssignmentOperation.CLAIM
      ? AdminAuditAction.REPORT_CLAIMED
      : AdminAuditAction.REPORT_REASSIGNED;
  }

  private async loadReplay(
    input: NormalizedInput,
  ): Promise<AdminReportAssignmentMutationResult | undefined> {
    try {
      const stored = await this.requests
        .findOne({ idempotencyHash: this.idempotencyHash(input) })
        .select('+requestFingerprint')
        .lean<StoredRequest | null>()
        .exec();
      if (!stored) return undefined;
      if (stored.requestFingerprint !== this.requestFingerprint(input)) {
        throw new AdminReportAssignmentIdempotencyConflictException();
      }
      if (
        stored.state !== AdminReportAssignmentRequestState.COMPLETED ||
        stored.resultStatus === null ||
        stored.resultAssigneePublicId === null ||
        stored.resultAssignedAt === null ||
        stored.resultVersion === null ||
        stored.resultUpdatedAt === null
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
  ): Promise<AdminReportAssignmentMutationResult | undefined> {
    const immediate = await this.loadReplay(input);
    if (immediate) return immediate;

    for (const delayMs of ADMIN_REPORT_ASSIGNMENT_REPLAY_WAIT_DELAYS_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const replay = await this.loadReplay(input);
      if (replay) return replay;
    }

    return undefined;
  }
  private storedResult(
    stored: CompletedStoredRequest,
  ): AdminReportAssignmentMutationResult {
    return Object.freeze({
      report: Object.freeze({
        id: stored.targetPublicId,
        publicId: stored.targetPublicId,
        kind: stored.resultKind,
        status: stored.resultStatus,
        assignee: Object.freeze({
          publicId: stored.resultAssigneePublicId,
          assignedAt: stored.resultAssignedAt.toISOString(),
        }),
        version: stored.resultVersion,
        updatedAt: stored.resultUpdatedAt.toISOString(),
      }),
    });
  }

  private toResult(
    kind: AdminReportAssignmentKind,
    report: StoredAssignment,
  ): AdminReportAssignmentMutationResult {
    return Object.freeze({
      report: Object.freeze({
        id: report.publicId,
        publicId: report.publicId,
        kind,
        status: this.publicStatus(kind, report.status),
        assignee: Object.freeze({
          publicId: report.assigneePublicId as string,
          assignedAt: (report.assignedAt as Date).toISOString(),
        }),
        version: report.version,
        updatedAt: report.updatedAt.toISOString(),
      }),
    });
  }

  private publicStatus(
    kind: AdminReportAssignmentKind,
    status: ReportStatus | SystemReportStatus,
  ): AdminReportQueueStatus {
    return kind === AdminReportAssignmentKind.REPORT
      ? REPORT_STATUS_TO_ADMIN[status as ReportStatus]
      : SYSTEM_REPORT_STATUS_TO_ADMIN[status as SystemReportStatus];
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
      input.operation,
      String(input.expectedVersion),
      input.assigneePublicId ?? '',
      input.adminNote ?? '',
      input.correlationId ?? '',
    ]);
  }

  private hash(parts: readonly string[]): string {
    return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      Number(error.code) === 11000
    );
  }

  private assignmentConflict(
    target: AssignmentTarget,
    message: string,
  ): AdminReportAssignmentConflictException {
    const hasAssignee =
      typeof target.assigneePublicId === 'string' &&
      target.assigneePublicId.length > 0 &&
      target.assignedAt instanceof Date;

    const currentAssignment: AdminReportAssignmentCurrentState = Object.freeze({
      publicId: target.publicId,
      kind: target.kind,
      status: this.publicStatus(target.kind, target.status),
      assignee: Object.freeze({
        publicId: hasAssignee ? target.assigneePublicId : null,
        assignedAt: hasAssignee ? target.assignedAt.toISOString() : null,
      }),
      version: target.version,
    });

    return new AdminReportAssignmentConflictException(
      message,
      currentAssignment,
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ phân công report tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
