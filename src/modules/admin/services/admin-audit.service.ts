import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import { AdminRole } from '../constants/admin-account.constants';
import { isAdminPermission } from '../constants/admin-permission.constants';
import {
  ADMIN_AUDIT_CORRELATION_ID_PATTERN,
  ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
  ADMIN_AUDIT_REASON_CODE_PATTERN,
  ADMIN_AUDIT_RETENTION_DAYS,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  type AdminAuditActorInput,
  type AdminAuditMetadataInput,
  type AdminAuditPage,
  type AdminAuditQuery,
  type AdminAuditTargetInput,
  type PublicAdminAuditEvent,
  type RecordAdminAuditInput,
} from '../interfaces/admin-audit.interface';
import { AdminAuditEvent } from '../schemas/admin-audit-event.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

const DAY_MS = 86_400_000;
const STATE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SENSITIVE_NOTE_PATTERN =
  /authorization|bearer|cookie|mật khẩu|password|otp|refresh.?token|access.?token|secret|recovery.?code/i;

const ACTION_TARGET_TYPE: Readonly<
  Record<AdminAuditAction, AdminAuditTargetType>
> = {
  [AdminAuditAction.BOOTSTRAP_GRANT_ISSUED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.BOOTSTRAP_GRANT_REISSUED]:
    AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.BOOTSTRAP_GRANT_REVOKED]:
    AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ACTIVATION_CONSUMED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_CREATED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_LOCKED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_UNLOCKED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_DELETED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_RESTORED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.ADMIN_PERMISSIONS_UPDATED]:
    AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.LOGIN_SUCCEEDED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.LOGIN_DENIED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.SESSION_CREATED]: AdminAuditTargetType.ADMIN_SESSION,
  [AdminAuditAction.SESSION_ROTATED]: AdminAuditTargetType.ADMIN_SESSION,
  [AdminAuditAction.SESSION_REVOKED]: AdminAuditTargetType.ADMIN_SESSION,
  [AdminAuditAction.SESSIONS_REVOKED_ALL]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.REFRESH_REPLAY_DETECTED]:
    AdminAuditTargetType.ADMIN_SESSION,
  [AdminAuditAction.PASSWORD_CHANGED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.MFA_ENROLLED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.MFA_RECOVERY_USED]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.MFA_RESET]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.BREAK_GLASS_RECOVERY]: AdminAuditTargetType.ADMIN_ACCOUNT,
  [AdminAuditAction.REAUTH_GRANT_ISSUED]: AdminAuditTargetType.REAUTH_GRANT,
  [AdminAuditAction.REAUTH_GRANT_CONSUMED]: AdminAuditTargetType.REAUTH_GRANT,
  [AdminAuditAction.USER_SUSPENDED]: AdminAuditTargetType.USER,
  [AdminAuditAction.USER_UNSUSPENDED]: AdminAuditTargetType.USER,
  [AdminAuditAction.USER_BANNED]: AdminAuditTargetType.USER,
  [AdminAuditAction.USER_UNBANNED]: AdminAuditTargetType.USER,
  [AdminAuditAction.USER_DELETED]: AdminAuditTargetType.USER,
  [AdminAuditAction.USER_RESTORED]: AdminAuditTargetType.USER,
  [AdminAuditAction.POST_HIDDEN]: AdminAuditTargetType.POST,
  [AdminAuditAction.POST_RESTORED]: AdminAuditTargetType.POST,
  [AdminAuditAction.POST_DELETED]: AdminAuditTargetType.POST,
  [AdminAuditAction.REPORT_CLAIMED]: AdminAuditTargetType.REPORT,
  [AdminAuditAction.REPORT_REASSIGNED]: AdminAuditTargetType.REPORT,
  [AdminAuditAction.REPORT_RESOLVED]: AdminAuditTargetType.REPORT,
  [AdminAuditAction.REPORT_REJECTED]: AdminAuditTargetType.REPORT,
  [AdminAuditAction.SYSTEM_REPORT_TRANSITIONED]:
    AdminAuditTargetType.SYSTEM_REPORT,
  [AdminAuditAction.SPONSORED_CREATED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_UPDATED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_DELETED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_RESTORED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_ACTIVATED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_EXPIRED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_PAUSED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.SPONSORED_RESUMED]: AdminAuditTargetType.SPONSORED_POST,
  [AdminAuditAction.CONTACT_REVEALED]: AdminAuditTargetType.REPORT,
  [AdminAuditAction.SECURITY_REQUEST_DENIED]:
    AdminAuditTargetType.SECURITY_CONTROL,
  [AdminAuditAction.AUDIT_LOG_ACCESSED]: AdminAuditTargetType.AUDIT_LOG,
};

const NON_TRANSACTIONAL_ACTIONS: ReadonlySet<AdminAuditAction> = new Set([
  AdminAuditAction.LOGIN_DENIED,
  AdminAuditAction.SECURITY_REQUEST_DENIED,
  AdminAuditAction.AUDIT_LOG_ACCESSED,
]);

const ACTIONS_WITHOUT_RBAC_PERMISSION: ReadonlySet<AdminAuditAction> = new Set([
  AdminAuditAction.LOGIN_SUCCEEDED,
  AdminAuditAction.LOGIN_DENIED,
  AdminAuditAction.SESSION_CREATED,
  AdminAuditAction.SESSION_ROTATED,
  AdminAuditAction.SESSION_REVOKED,
  AdminAuditAction.SESSIONS_REVOKED_ALL,
  AdminAuditAction.REFRESH_REPLAY_DETECTED,
  AdminAuditAction.PASSWORD_CHANGED,
  AdminAuditAction.MFA_ENROLLED,
  AdminAuditAction.MFA_RECOVERY_USED,
  AdminAuditAction.MFA_RESET,
]);

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

type StoredAuditEvent = Omit<AdminAuditEvent, 'occurredAt'> & {
  occurredAt: Date;
};

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @InjectModel(AdminAuditEvent.name)
    private readonly auditModel: Model<AdminAuditEvent>,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
  ) {
    if (policy.retention.adminAuditDays !== ADMIN_AUDIT_RETENTION_DAYS) {
      throw new Error('Admin audit retention phải cố định 365 ngày');
    }
  }

  async record(input: RecordAdminAuditInput): Promise<string> {
    if (
      !NON_TRANSACTIONAL_ACTIONS.has(input.action) &&
      input.mongoSession?.inTransaction() !== true
    ) {
      throw new TypeError(
        'Admin audit action có mutation phải dùng MongoDB transaction đang active',
      );
    }
    const document = this.normalizeRecord(input);

    try {
      const result = await this.auditModel.insertMany([document], {
        ordered: true,
        session: input.mongoSession,
      });

      const publicId = result[0]?.publicId;
      if (typeof publicId !== 'string') {
        throw new Error('Admin audit insert không trả public ID');
      }

      return publicId;
    } catch (error: unknown) {
      this.logPersistenceFailure(input.action, error);
      if (input.mongoSession) throw error;
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể ghi nhận sự kiện quản trị',
        );
      }
      throw error;
    }
  }

  async list(query: AdminAuditQuery): Promise<AdminAuditPage> {
    this.validateQuery(query);
    const now = new Date();
    const filter: Record<string, unknown> = { expiresAt: { $gt: now } };

    if (query.actorPublicId) filter['actor.publicId'] = query.actorPublicId;
    if (query.action) filter.action = query.action;
    if (query.targetType) filter['target.type'] = query.targetType;
    if (query.targetPublicId) {
      filter['target.publicId'] = query.targetPublicId;
    }
    if (query.outcome) filter.outcome = query.outcome;
    if (query.from || query.to) {
      filter.occurredAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }

    try {
      const records = await this.auditModel
        .find(filter)
        .sort({ occurredAt: -1, publicId: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit + 1)
        .select('-_id -expiresAt')
        .lean<StoredAuditEvent[]>()
        .exec();

      const hasMore = records.length > query.limit;
      const items = records
        .slice(0, query.limit)
        .map((record) => this.toPublicEvent(record));

      return Object.freeze({
        items: Object.freeze(items),
        pagination: Object.freeze({
          page: query.page,
          limit: query.limit,
          hasMore,
        }),
      });
    } catch (error: unknown) {
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể truy vấn nhật ký quản trị',
        );
      }
      throw error;
    }
  }

  private normalizeRecord(
    input: RecordAdminAuditInput,
  ): Record<string, unknown> {
    if (!Object.values(AdminAuditAction).includes(input.action)) {
      throw new TypeError('Admin audit action không hợp lệ');
    }
    if (!Object.values(AdminAuditOutcome).includes(input.outcome)) {
      throw new TypeError('Admin audit outcome không hợp lệ');
    }
    if (!Object.values(AdminAuditSource).includes(input.source)) {
      throw new TypeError('Admin audit source không hợp lệ');
    }

    const actor = this.normalizeActor(input.actor, input.action);
    const target = this.normalizeTarget(input.target);
    if (ACTION_TARGET_TYPE[input.action] !== target.type) {
      throw new TypeError('Admin audit target không khớp action');
    }
    if (!ADMIN_AUDIT_REASON_CODE_PATTERN.test(input.reasonCode)) {
      throw new TypeError('Admin audit reason code không hợp lệ');
    }

    const reasonNote = this.normalizeOptionalText(
      input.reasonNote,
      500,
      'reasonNote',
      true,
    );
    const metadata = this.normalizeMetadata(input.metadata);

    if (
      input.correlationId !== undefined &&
      !ADMIN_AUDIT_CORRELATION_ID_PATTERN.test(input.correlationId)
    ) {
      throw new TypeError('Admin audit correlation ID không hợp lệ');
    }

    return {
      action: input.action,
      outcome: input.outcome,
      actor,
      target,
      reasonCode: input.reasonCode,
      ...(reasonNote ? { reasonNote } : {}),
      ...(metadata ? { metadata } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      source: input.source,
      expiresAt: new Date(Date.now() + ADMIN_AUDIT_RETENTION_DAYS * DAY_MS),
    };
  }

  private normalizeActor(
    actor: AdminAuditActorInput,
    action: AdminAuditAction,
  ): Record<string, unknown> {
    if (!Object.values(AdminAuditActorType).includes(actor.type)) {
      throw new TypeError('Admin audit actor type không hợp lệ');
    }
    const displayName = this.normalizeRequiredText(
      actor.displayName,
      120,
      'actor.displayName',
    );

    if (actor.type === AdminAuditActorType.ADMIN_ACCOUNT) {
      if (
        !isValidAdminPublicId(actor.publicId) ||
        !actor.username ||
        (actor.role !== AdminRole.ADMIN &&
          actor.role !== AdminRole.SUPER_ADMIN) ||
        (actor.permission === undefined
          ? !ACTIONS_WITHOUT_RBAC_PERMISSION.has(action)
          : !isAdminPermission(actor.permission)) ||
        !Number.isSafeInteger(actor.permissionVersion) ||
        Number(actor.permissionVersion) < 1
      ) {
        throw new TypeError('Admin audit actor AdminAccount không hợp lệ');
      }
      return {
        type: actor.type,
        publicId: actor.publicId,
        username: this.normalizeRequiredText(
          actor.username,
          40,
          'actor.username',
        ),
        displayName,
        role: actor.role,
        ...(actor.permission !== undefined
          ? { permission: actor.permission }
          : {}),
        permissionVersion: actor.permissionVersion,
      };
    }

    if (
      actor.publicId !== undefined ||
      actor.username !== undefined ||
      actor.role !== undefined ||
      actor.permission !== undefined ||
      actor.permissionVersion !== undefined
    ) {
      throw new TypeError('System actor không được mang Admin principal');
    }

    return { type: actor.type, displayName };
  }

  private normalizeTarget(
    target: AdminAuditTargetInput,
  ): Record<string, unknown> {
    if (
      !Object.values(AdminAuditTargetType).includes(target.type) ||
      !ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN.test(target.publicId)
    ) {
      throw new TypeError('Admin audit target không hợp lệ');
    }
    const displayName = this.normalizeOptionalText(
      target.displayName,
      120,
      'target.displayName',
      false,
    );
    return {
      type: target.type,
      publicId: target.publicId,
      ...(displayName ? { displayName } : {}),
    };
  }

  private normalizeMetadata(
    metadata?: AdminAuditMetadataInput,
  ): Record<string, unknown> | undefined {
    if (metadata === undefined) return undefined;
    if (!this.isPlainObject(metadata)) {
      throw new TypeError('Admin audit metadata phải là plain object');
    }
    const allowed = new Set([
      'beforeVersion',
      'afterVersion',
      'beforeState',
      'afterState',
      'affectedSessionCount',
    ]);
    for (const key of Object.keys(metadata)) {
      if (!allowed.has(key)) {
        throw new TypeError(`Admin audit metadata không hỗ trợ: ${key}`);
      }
    }

    const normalized: Record<string, unknown> = {};
    for (const key of [
      'beforeVersion',
      'afterVersion',
      'affectedSessionCount',
    ] as const) {
      const value = metadata[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
          throw new TypeError(`Admin audit metadata ${key} không hợp lệ`);
        }
        normalized[key] = value;
      }
    }
    for (const key of ['beforeState', 'afterState'] as const) {
      const value = metadata[key];
      if (value !== undefined) {
        const state = value.trim();
        if (!STATE_PATTERN.test(state)) {
          throw new TypeError(`Admin audit metadata ${key} không hợp lệ`);
        }
        normalized[key] = state;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  private validateQuery(query: AdminAuditQuery): void {
    if (
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > this.policy.pagination.maximumLimit
    ) {
      throw new TypeError('Admin audit pagination không hợp lệ');
    }
    if (query.actorPublicId && !isValidAdminPublicId(query.actorPublicId)) {
      throw new TypeError('Admin audit actor filter không hợp lệ');
    }
    if (
      query.action &&
      !Object.values(AdminAuditAction).includes(query.action)
    ) {
      throw new TypeError('Admin audit action filter không hợp lệ');
    }
    if (
      query.targetType &&
      !Object.values(AdminAuditTargetType).includes(query.targetType)
    ) {
      throw new TypeError('Admin audit target type filter không hợp lệ');
    }
    if (
      query.targetPublicId &&
      !ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN.test(query.targetPublicId)
    ) {
      throw new TypeError('Admin audit target filter không hợp lệ');
    }
    if (
      query.outcome &&
      !Object.values(AdminAuditOutcome).includes(query.outcome)
    ) {
      throw new TypeError('Admin audit outcome filter không hợp lệ');
    }
    if (
      (query.from && Number.isNaN(query.from.getTime())) ||
      (query.to && Number.isNaN(query.to.getTime())) ||
      (query.from && query.to && query.from > query.to)
    ) {
      throw new TypeError('Admin audit time range không hợp lệ');
    }
  }

  private toPublicEvent(record: StoredAuditEvent): PublicAdminAuditEvent {
    const actor = Object.freeze({
      type: record.actor.type,
      ...(record.actor.publicId !== undefined
        ? { publicId: record.actor.publicId }
        : {}),
      ...(record.actor.username !== undefined
        ? { username: record.actor.username }
        : {}),
      displayName: record.actor.displayName,
      ...(record.actor.role !== undefined ? { role: record.actor.role } : {}),
      ...(record.actor.permission !== undefined
        ? { permission: record.actor.permission }
        : {}),
      ...(record.actor.permissionVersion !== undefined
        ? { permissionVersion: record.actor.permissionVersion }
        : {}),
    });
    const target = Object.freeze({
      type: record.target.type,
      publicId: record.target.publicId,
      ...(record.target.displayName !== undefined
        ? { displayName: record.target.displayName }
        : {}),
    });
    const metadata = record.metadata
      ? Object.freeze({
          ...(record.metadata.beforeVersion !== undefined
            ? { beforeVersion: record.metadata.beforeVersion }
            : {}),
          ...(record.metadata.afterVersion !== undefined
            ? { afterVersion: record.metadata.afterVersion }
            : {}),
          ...(record.metadata.beforeState !== undefined
            ? { beforeState: record.metadata.beforeState }
            : {}),
          ...(record.metadata.afterState !== undefined
            ? { afterState: record.metadata.afterState }
            : {}),
          ...(record.metadata.affectedSessionCount !== undefined
            ? {
                affectedSessionCount: record.metadata.affectedSessionCount,
              }
            : {}),
        })
      : undefined;

    return Object.freeze({
      id: record.publicId,
      schemaVersion: record.schemaVersion,
      action: record.action,
      outcome: record.outcome,
      actor,
      target,
      reasonCode: record.reasonCode,
      ...(record.reasonNote ? { reasonNote: record.reasonNote } : {}),
      ...(metadata ? { metadata } : {}),
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
      source: record.source,
      occurredAt: record.occurredAt.toISOString(),
    });
  }

  private normalizeRequiredText(
    value: string,
    max: number,
    field: string,
  ): string {
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > max ||
      containsUnsafeControlCharacter(normalized)
    ) {
      throw new TypeError(`Admin audit ${field} không hợp lệ`);
    }
    return normalized;
  }

  private normalizeOptionalText(
    value: string | undefined,
    max: number,
    field: string,
    rejectSensitive: boolean,
  ): string | undefined {
    if (value === undefined) return undefined;
    const normalized = this.normalizeRequiredText(value, max, field);
    if (rejectSensitive && SENSITIVE_NOTE_PATTERN.test(normalized)) {
      throw new TypeError(`Admin audit ${field} chứa dữ liệu bị cấm`);
    }
    return normalized;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  }

  private logPersistenceFailure(
    action: AdminAuditAction,
    error: unknown,
  ): void {
    const source =
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>)
        : {};
    const code =
      typeof source.code === 'string' || typeof source.code === 'number'
        ? source.code
        : 'none';
    this.logger.error(
      `Admin audit persistence failed action=${action} ` +
        `errorName=${error instanceof Error ? error.name : 'UnknownError'} ` +
        `errorCode=${String(code)}`,
    );
  }
}
