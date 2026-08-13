import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { createHash } from 'node:crypto';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import {
  ADMIN_ACTIVATION_SECRET_NAME_PREFIX,
  ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_TTL_MS,
  ADMIN_CREATE_REAUTH_TARGET_PUBLIC_ID,
  ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN,
  ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN,
  ADMIN_LIFECYCLE_REASON_CODE_PATTERN,
  ADMIN_LIFECYCLE_USERNAME_PATTERN,
} from '../constants/admin-lifecycle.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { ADMIN_SECURITY_GRANT_PATTERN } from '../constants/admin-account-recovery.constants';
import {
  type CreateAdminAccountInput,
  type CreateAdminAccountResult,
  type IssueCreateAdminReauthInput,
} from '../interfaces/admin-account-lifecycle.interface';
import {
  ADMIN_BOOTSTRAP_SECRET_STORE,
  type AdminBootstrapSecretStore,
} from '../interfaces/admin-bootstrap.interface';
import { toPublicAdminAccount } from '../mappers/admin-account-public.mapper';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminAccountCreationRequest } from '../schemas/admin-account-creation-request.schema';
import {
  generateAdminActivationGrant,
  hashAdminActivationGrant,
} from '../utils/admin-activation-grant';
import { generateAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminReauthService } from './admin-reauth.service';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_DOMAIN = 'betta:admin-account-create:idempotency:v1';
const FINGERPRINT_DOMAIN = 'betta:admin-account-create:fingerprint:v1';

type StoredCreationRequest = Readonly<{
  requestFingerprint: string;
  targetAdminAccountId: Types.ObjectId;
  targetAdminPublicId: string;
  secretReference: string;
  activationExpiresAt: Date;
}>;

type NormalizedCreateInput = Omit<
  CreateAdminAccountInput,
  'email' | 'username' | 'displayName' | 'reasonCode' | 'reasonNote'
> &
  Readonly<{
    email: string;
    username: string;
    displayName: string;
    reasonCode: string;
    reasonNote?: string;
  }>;

@Injectable()
export class AdminAccountLifecycleService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminAccountCreationRequest.name)
    private readonly creationRequests: Model<AdminAccountCreationRequest>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    @Inject(ADMIN_BOOTSTRAP_SECRET_STORE)
    private readonly secretStore: AdminBootstrapSecretStore,
    private readonly reauth: AdminReauthService,
    private readonly audit: AdminAuditService,
  ) {}

  issueCreateReauth(input: IssueCreateAdminReauthInput) {
    this.assertActor(input.actor);
    if (
      typeof input.password !== 'string' ||
      input.password.length === 0 ||
      typeof input.totpToken !== 'string' ||
      !/^\d{6}$/u.test(input.totpToken) ||
      typeof input.trustedClientIp !== 'string' ||
      input.trustedClientIp.length === 0
    ) {
      throw new TypeError('Admin create re-auth input không hợp lệ');
    }

    return this.reauth.issue({
      adminAccountId: input.actor.adminAccountId,
      adminPublicId: input.actor.publicId,
      sessionPublicId: input.actor.sessionPublicId,
      password: input.password,
      totpToken: input.totpToken,
      purpose: AdminReauthPurpose.ADMINS_CREATE,
      targetPublicId: ADMIN_CREATE_REAUTH_TARGET_PUBLIC_ID,
      trustedClientIp: input.trustedClientIp,
      actor: input.actor,
      source: AdminAuditSource.HTTP,
    });
  }

  async createAdmin(
    input: CreateAdminAccountInput,
  ): Promise<CreateAdminAccountResult> {
    const normalized = this.normalizeCreateInput(input);
    const existing = await this.loadIdempotentResult(normalized);
    if (existing) return existing;
    this.secretStore.assertReady();

    const publicId = generateAdminPublicId();
    const accountId = new Types.ObjectId();
    const expiresAt = new Date(
      Date.now() + this.policy.activation.grantTtlSeconds * 1_000,
    );
    const idempotencyExpiresAt = new Date(
      Date.now() + ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_TTL_MS,
    );
    const context = Object.freeze({
      purpose: AdminActivationGrantPurpose.ADMIN_ACCOUNT_ACTIVATION,
      targetPublicId: publicId,
      environment: this.policy.environment as AdminBootstrapEnvironment,
    });
    const rawGrant = generateAdminActivationGrant();
    const grantHash = hashAdminActivationGrant(rawGrant, context);
    const secretReference = await this.secretStore.putVersion({
      secretName: `${ADMIN_ACTIVATION_SECRET_NAME_PREFIX}/${publicId.toLowerCase()}`,
      rawGrant,
      expiresAt,
      context,
    });

    try {
      const created = await this.connection.transaction(
        async (mongoSession) => {
          await this.creationRequests.create(
            [
              {
                idempotencyHash: this.idempotencyHash(normalized),
                requestFingerprint: this.requestFingerprint(normalized),
                actorPublicId: normalized.actor.publicId,
                actorSessionPublicId: normalized.actor.sessionPublicId,
                targetAdminAccountId: accountId,
                targetAdminPublicId: publicId,
                secretReference,
                activationExpiresAt: expiresAt,
                idempotencyExpiresAt,
              },
            ],
            { session: mongoSession },
          );

          await this.reauth.consumeInTransaction({
            rawGrant: normalized.reauthGrant,
            adminAccountId: normalized.actor.adminAccountId,
            adminPublicId: normalized.actor.publicId,
            sessionPublicId: normalized.actor.sessionPublicId,
            credentialVersion: normalized.actor.credentialVersion,
            authzVersion: normalized.actor.authzVersion,
            permissionVersion: normalized.actor.permissionVersion,
            purpose: AdminReauthPurpose.ADMINS_CREATE,
            targetPublicId: ADMIN_CREATE_REAUTH_TARGET_PUBLIC_ID,
            actor: normalized.actor,
            source: AdminAuditSource.HTTP,
            mongoSession,
          });

          const [account] = await this.accounts.create(
            [
              {
                _id: accountId,
                publicId,
                email: normalized.email,
                username: normalized.username,
                displayName: normalized.displayName,
                role: AdminRole.ADMIN,
                status: AdminAccountStatus.PENDING_ACTIVATION,
                mfaStatus: AdminMfaStatus.NOT_ENROLLED,
                mustChangePassword: true,
                activationGrantHash: grantHash,
                activationGrantExpiresAt: expiresAt,
                activationGrantConsumedAt: null,
              },
            ],
            { session: mongoSession },
          );

          await this.recordCreatedAudit(normalized, publicId, mongoSession);
          return account;
        },
      );

      return Object.freeze({
        admin: Object.freeze(toPublicAdminAccount(created)),
        activation: Object.freeze({
          secretReference,
          expiresAt: expiresAt.toISOString(),
        }),
      });
    } catch (error: unknown) {
      await this.compensateSecret(secretReference);
      if (this.isDuplicateKey(error)) {
        const replay = await this.loadIdempotentResult(normalized);
        if (replay) return replay;
        throw new ConflictException(
          'Email hoặc username Admin đã được sử dụng',
        );
      }
      this.rethrow(error);
    }
  }

  private normalizeCreateInput(
    input: CreateAdminAccountInput,
  ): NormalizedCreateInput {
    this.assertActor(input.actor);
    const email = normalizeAuthEmail(input.email);
    const username =
      typeof input.username === 'string'
        ? input.username.trim().toLowerCase()
        : '';
    const displayName =
      typeof input.displayName === 'string' ? input.displayName.trim() : '';
    const reasonCode =
      typeof input.reasonCode === 'string' ? input.reasonCode.trim() : '';
    const reasonNote = input.reasonNote?.trim();

    if (
      !EMAIL_PATTERN.test(email) ||
      email.length > 254 ||
      !ADMIN_LIFECYCLE_USERNAME_PATTERN.test(username) ||
      displayName.length < 1 ||
      displayName.length > 120 ||
      !ADMIN_LIFECYCLE_REASON_CODE_PATTERN.test(reasonCode) ||
      (reasonNote !== undefined &&
        (reasonNote.length < 1 || reasonNote.length > 500)) ||
      (input.correlationId !== undefined &&
        !ADMIN_LIFECYCLE_CORRELATION_ID_PATTERN.test(input.correlationId)) ||
      typeof input.idempotencyKey !== 'string' ||
      !ADMIN_LIFECYCLE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      typeof input.reauthGrant !== 'string' ||
      !ADMIN_SECURITY_GRANT_PATTERN.test(input.reauthGrant)
    ) {
      throw new TypeError('Create Admin input không hợp lệ');
    }

    return Object.freeze({
      ...input,
      email,
      username,
      displayName,
      reasonCode,
      reasonNote,
    });
  }

  private async loadIdempotentResult(
    input: NormalizedCreateInput,
  ): Promise<CreateAdminAccountResult | undefined> {
    try {
      const request = await this.creationRequests
        .findOne({ idempotencyHash: this.idempotencyHash(input) })
        .select('+requestFingerprint +targetAdminAccountId +secretReference')
        .lean<StoredCreationRequest | null>()
        .exec();
      if (!request) return undefined;
      if (request.requestFingerprint !== this.requestFingerprint(input)) {
        throw new ConflictException(
          'Idempotency-Key đã được dùng cho payload khác',
        );
      }

      const account = await this.accounts
        .findOne({
          _id: request.targetAdminAccountId,
          publicId: request.targetAdminPublicId,
        })
        .lean<AdminAccount | null>()
        .exec();
      if (!account) {
        throw new ServiceUnavailableException(
          'Admin creation idempotency state không nhất quán',
        );
      }

      return Object.freeze({
        admin: Object.freeze(toPublicAdminAccount(account)),
        activation: Object.freeze({
          secretReference: request.secretReference,
          expiresAt: request.activationExpiresAt.toISOString(),
        }),
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private idempotencyHash(input: NormalizedCreateInput): string {
    return this.hash([
      IDEMPOTENCY_DOMAIN,
      input.actor.publicId,
      input.idempotencyKey,
    ]);
  }

  private requestFingerprint(input: NormalizedCreateInput): string {
    return this.hash([
      FINGERPRINT_DOMAIN,
      input.email,
      input.username,
      input.displayName,
      input.reasonCode,
      input.reasonNote ?? '',
      input.correlationId ?? '',
    ]);
  }

  private hash(parts: readonly string[]): string {
    return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
  }

  private assertActor(actor: CreateAdminAccountInput['actor']): void {
    if (
      actor.type !== AdminAuditActorType.ADMIN_ACCOUNT ||
      actor.role !== AdminRole.SUPER_ADMIN ||
      actor.permission !== AdminPermission.ADMINS_CREATE ||
      !(actor.adminAccountId instanceof Types.ObjectId) ||
      typeof actor.publicId !== 'string' ||
      typeof actor.sessionPublicId !== 'string' ||
      !Number.isSafeInteger(actor.credentialVersion) ||
      actor.credentialVersion < 0 ||
      !Number.isSafeInteger(actor.authzVersion) ||
      actor.authzVersion < 0 ||
      !Number.isSafeInteger(actor.permissionVersion) ||
      actor.permissionVersion < 1
    ) {
      throw new ForbiddenException(
        'Chỉ SuperAdmin có quyền mới được tạo Admin',
      );
    }
  }

  private recordCreatedAudit(
    input: NormalizedCreateInput,
    targetPublicId: string,
    mongoSession: ClientSession,
  ): Promise<string> {
    return this.audit.record({
      action: AdminAuditAction.ADMIN_CREATED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: input.actor,
      target: {
        type: AdminAuditTargetType.ADMIN_ACCOUNT,
        publicId: targetPublicId,
        displayName: input.displayName,
      },
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote,
      metadata: {
        afterState: AdminAccountStatus.PENDING_ACTIVATION,
        afterVersion: 0,
      },
      correlationId: input.correlationId,
      source: AdminAuditSource.HTTP,
      mongoSession,
    });
  }

  private async compensateSecret(secretReference: string): Promise<void> {
    try {
      await this.secretStore.revokeVersion(secretReference);
    } catch {
      throw new ServiceUnavailableException(
        'Không thể hoàn tất hoặc thu hồi activation grant Admin',
      );
    }
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
    if (error instanceof HttpException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ quản lý Admin tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
