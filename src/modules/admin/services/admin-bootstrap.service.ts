import {
  ConflictException,
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
  ADMIN_BOOTSTRAP_CORRELATION_ID_PATTERN,
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
  AdminBootstrapMode,
  AdminBootstrapOutcome,
} from '../constants/admin-bootstrap.constants';
import {
  ADMIN_BOOTSTRAP_SECRET_STORE,
  type AdminBootstrapRequest,
  type AdminBootstrapResult,
  type AdminBootstrapSecretStore,
  type StoredAdminBootstrapState,
} from '../interfaces/admin-bootstrap.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminBootstrapState } from '../schemas/admin-bootstrap-state.schema';
import {
  generateAdminActivationGrant,
  hashAdminActivationGrant,
} from '../utils/admin-activation-grant';
import { generateAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/;
const OPERATOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{2,119}$/;
const SECRET_NAME_PREFIX = 'betta/admin/bootstrap-super-admin';

type NormalizedRequest = Readonly<{
  email: string;
  username: string;
  displayName: string;
  operatorReference: string;
  correlationId?: string;
  reissue: boolean;
}>;

type BootstrapAccount = Readonly<{
  _id: Types.ObjectId;
  publicId: string;
  status: AdminAccountStatus;
  role: AdminRole;
  activationGrantHash?: string;
  activationGrantExpiresAt?: Date;
  activationGrantConsumedAt?: Date | null;
}>;

@Injectable()
export class AdminBootstrapService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accountModel: Model<AdminAccount>,
    @InjectModel(AdminBootstrapState.name)
    private readonly stateModel: Model<AdminBootstrapState>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    @Inject(ADMIN_BOOTSTRAP_SECRET_STORE)
    private readonly secretStore: AdminBootstrapSecretStore,
    private readonly audit: AdminAuditService,
  ) {}

  async inspect(input: AdminBootstrapRequest): Promise<AdminBootstrapResult> {
    const request = this.normalizeRequest(input);
    const current = await this.loadCurrentState();

    if (!current) {
      return Object.freeze({
        mode: AdminBootstrapMode.DRY_RUN,
        outcome: AdminBootstrapOutcome.WOULD_CREATE,
      });
    }

    return Object.freeze({
      mode: AdminBootstrapMode.DRY_RUN,
      outcome:
        request.reissue &&
        current.state !== undefined &&
        this.canReissue(current.account, current.state)
          ? AdminBootstrapOutcome.WOULD_REISSUE
          : AdminBootstrapOutcome.SKIPPED,
      adminPublicId: current.account.publicId,
    });
  }

  async execute(input: AdminBootstrapRequest): Promise<AdminBootstrapResult> {
    const request = this.normalizeRequest(input);
    this.secretStore.assertReady();
    const current = await this.loadCurrentState();

    if (current) {
      if (
        !request.reissue ||
        current.state === undefined ||
        !this.canReissue(current.account, current.state)
      ) {
        return this.skipped(current.account.publicId);
      }
      return this.reissue(request, current.account, current.state);
    }

    return this.createInitial(request);
  }

  private async createInitial(
    request: NormalizedRequest,
  ): Promise<AdminBootstrapResult> {
    const publicId = generateAdminPublicId();
    const accountId = new Types.ObjectId();
    const expiresAt = this.grantExpiry();
    const context = this.grantContext(publicId);
    const rawGrant = generateAdminActivationGrant();
    const grantHash = hashAdminActivationGrant(rawGrant, context);
    const secretReference = await this.secretStore.putVersion({
      secretName: this.secretName(),
      rawGrant,
      expiresAt,
      context,
    });

    try {
      await this.connection.transaction(async (mongoSession) => {
        await this.accountModel.create(
          [
            {
              _id: accountId,
              publicId,
              email: request.email,
              username: request.username,
              displayName: request.displayName,
              role: AdminRole.SUPER_ADMIN,
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
        await this.stateModel.create(
          [
            {
              key: ADMIN_BOOTSTRAP_SINGLETON_KEY,
              adminAccountId: accountId,
              adminPublicId: publicId,
              purpose: context.purpose,
              environment: context.environment,
              generation: 1,
              grantHash,
              grantExpiresAt: expiresAt,
              consumedAt: null,
              secretReference,
            },
          ],
          { session: mongoSession },
        );
        await this.recordAudit(
          AdminAuditAction.BOOTSTRAP_GRANT_ISSUED,
          request,
          publicId,
          0,
          1,
          mongoSession,
        );
      });
    } catch (error: unknown) {
      await this.compensateSecret(secretReference);
      if (this.isDuplicateKey(error)) {
        const winner = await this.loadCurrentState();
        if (winner) return this.skipped(winner.account.publicId);
        throw new ConflictException('Admin bootstrap identity đã tồn tại');
      }
      this.rethrowPersistence(error);
    }

    return Object.freeze({
      mode: AdminBootstrapMode.EXECUTE,
      outcome: AdminBootstrapOutcome.CREATED,
      adminPublicId: publicId,
      secretReference,
      expiresAt: expiresAt.toISOString(),
    });
  }

  private async reissue(
    request: NormalizedRequest,
    account: BootstrapAccount,
    state: StoredAdminBootstrapState,
  ): Promise<AdminBootstrapResult> {
    const expiresAt = this.grantExpiry();
    const context = this.grantContext(account.publicId);
    const rawGrant = generateAdminActivationGrant();
    const grantHash = hashAdminActivationGrant(rawGrant, context);
    const secretReference = await this.secretStore.putVersion({
      secretName: this.secretName(),
      rawGrant,
      expiresAt,
      context,
    });
    const nextGeneration = state.generation + 1;

    try {
      await this.connection.transaction(async (mongoSession) => {
        const accountResult = await this.accountModel.updateOne(
          {
            _id: account._id,
            publicId: account.publicId,
            role: AdminRole.SUPER_ADMIN,
            status: AdminAccountStatus.PENDING_ACTIVATION,
            activationGrantHash: state.grantHash,
            activationGrantExpiresAt: state.grantExpiresAt,
            activationGrantConsumedAt: null,
          },
          {
            $set: {
              activationGrantHash: grantHash,
              activationGrantExpiresAt: expiresAt,
            },
          },
          { session: mongoSession, runValidators: true },
        );
        const stateResult = await this.stateModel.updateOne(
          {
            _id: state._id,
            key: ADMIN_BOOTSTRAP_SINGLETON_KEY,
            adminAccountId: account._id,
            adminPublicId: account.publicId,
            generation: state.generation,
            grantHash: state.grantHash,
            consumedAt: null,
          },
          {
            $set: {
              grantHash,
              grantExpiresAt: expiresAt,
              secretReference,
            },
            $inc: { generation: 1 },
          },
          { session: mongoSession, runValidators: true },
        );

        if (
          accountResult.modifiedCount !== 1 ||
          stateResult.modifiedCount !== 1
        ) {
          throw new ConflictException('Bootstrap grant đã thay đổi');
        }
        await this.recordAudit(
          AdminAuditAction.BOOTSTRAP_GRANT_REISSUED,
          request,
          account.publicId,
          state.generation,
          nextGeneration,
          mongoSession,
        );
      });
    } catch (error: unknown) {
      await this.compensateSecret(secretReference);
      this.rethrowPersistence(error);
    }

    return Object.freeze({
      mode: AdminBootstrapMode.EXECUTE,
      outcome: AdminBootstrapOutcome.REISSUED,
      adminPublicId: account.publicId,
      secretReference,
      expiresAt: expiresAt.toISOString(),
    });
  }

  private async loadCurrentState(): Promise<
    | Readonly<{
        account: BootstrapAccount;
        state?: StoredAdminBootstrapState;
      }>
    | undefined
  > {
    try {
      const state = await this.stateModel
        .findOne({ key: ADMIN_BOOTSTRAP_SINGLETON_KEY })
        .select('+grantHash +consumedAt +secretReference')
        .lean<StoredAdminBootstrapState | null>()
        .exec();

      if (state) {
        const account = await this.loadBootstrapAccount({
          _id: state.adminAccountId,
          publicId: state.adminPublicId,
          role: AdminRole.SUPER_ADMIN,
        });
        if (!account) {
          throw new ServiceUnavailableException(
            'Bootstrap state không nhất quán',
          );
        }
        return Object.freeze({ account, state });
      }

      const existingSuperAdmin = await this.loadBootstrapAccount({
        role: AdminRole.SUPER_ADMIN,
      });
      if (!existingSuperAdmin) return undefined;

      return Object.freeze({ account: existingSuperAdmin });
    } catch (error: unknown) {
      this.rethrowPersistence(error);
    }
  }

  private async loadBootstrapAccount(
    filter: Record<string, unknown>,
  ): Promise<BootstrapAccount | null> {
    return this.accountModel
      .findOne(filter)
      .select(
        '_id publicId role status +activationGrantHash ' +
          '+activationGrantExpiresAt +activationGrantConsumedAt',
      )
      .lean<BootstrapAccount | null>()
      .exec();
  }

  private canReissue(
    account: BootstrapAccount,
    state: StoredAdminBootstrapState,
  ): boolean {
    return (
      account.role === AdminRole.SUPER_ADMIN &&
      account.status === AdminAccountStatus.PENDING_ACTIVATION &&
      account.activationGrantConsumedAt == null &&
      state.consumedAt == null &&
      account.activationGrantHash === state.grantHash &&
      account.activationGrantExpiresAt?.getTime() ===
        state.grantExpiresAt.getTime()
    );
  }

  private async recordAudit(
    action: AdminAuditAction,
    request: NormalizedRequest,
    adminPublicId: string,
    beforeVersion: number,
    afterVersion: number,
    mongoSession: ClientSession,
  ): Promise<void> {
    await this.audit.record({
      action,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.DEPLOYMENT_OPERATOR,
        displayName: request.operatorReference,
      },
      target: {
        type: AdminAuditTargetType.ADMIN_ACCOUNT,
        publicId: adminPublicId,
      },
      reasonCode:
        action === AdminAuditAction.BOOTSTRAP_GRANT_ISSUED
          ? 'initial_super_admin_bootstrap'
          : 'initial_super_admin_grant_reissue',
      metadata: { beforeVersion, afterVersion },
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
      source: AdminAuditSource.CLI,
      mongoSession,
    });
  }

  private normalizeRequest(input: AdminBootstrapRequest): NormalizedRequest {
    const email = normalizeAuthEmail(input.identity?.email);
    const username = input.identity?.username?.trim().toLowerCase();
    const displayName = input.identity?.displayName?.trim();
    const operatorReference = input.operatorReference?.trim();
    const correlationId = input.correlationId?.trim();

    if (
      !EMAIL_PATTERN.test(email) ||
      email.length > 254 ||
      !USERNAME_PATTERN.test(username ?? '') ||
      !displayName ||
      displayName.length > 120 ||
      !operatorReference ||
      !OPERATOR_REFERENCE_PATTERN.test(operatorReference) ||
      (correlationId !== undefined &&
        !ADMIN_BOOTSTRAP_CORRELATION_ID_PATTERN.test(correlationId)) ||
      typeof input.reissue !== 'boolean'
    ) {
      throw new TypeError('Admin bootstrap input không hợp lệ');
    }

    return Object.freeze({
      email,
      username,
      displayName,
      operatorReference,
      ...(correlationId ? { correlationId } : {}),
      reissue: input.reissue,
    });
  }

  private grantContext(adminPublicId: string) {
    return Object.freeze({
      purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
      targetPublicId: adminPublicId,
      environment: this.policy.environment as AdminBootstrapEnvironment,
    });
  }

  private grantExpiry(): Date {
    return new Date(
      Date.now() + this.policy.activation.grantTtlSeconds * 1_000,
    );
  }

  private secretName(): string {
    return `${SECRET_NAME_PREFIX}/${this.policy.environment}`;
  }

  private skipped(adminPublicId: string): AdminBootstrapResult {
    return Object.freeze({
      mode: AdminBootstrapMode.EXECUTE,
      outcome: AdminBootstrapOutcome.SKIPPED,
      adminPublicId,
    });
  }

  private async compensateSecret(secretReference: string): Promise<void> {
    try {
      await this.secretStore.revokeVersion(secretReference);
    } catch {
      throw new ServiceUnavailableException(
        'Bootstrap thất bại; cần kiểm tra Secret Manager',
      );
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11_000
    );
  }

  private rethrowPersistence(error: unknown): never {
    if (
      error instanceof ConflictException ||
      error instanceof ServiceUnavailableException
    ) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Không thể hoàn tất Admin bootstrap',
      );
    }
    throw new ServiceUnavailableException('Không thể hoàn tất Admin bootstrap');
  }
}
