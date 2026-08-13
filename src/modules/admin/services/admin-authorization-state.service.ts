import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_AUTHORIZATION_ACCOUNT_CACHE_MAX_ENTRIES,
  ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS,
  ADMIN_AUTHORIZATION_CLOCK,
  type AdminAuthorizationClock,
} from '../constants/admin-authorization-state.constants';
import {
  ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import {
  type AdminAuthorizationAccountState,
  type ResolveAdminAuthorizationInput,
} from '../interfaces/admin-authorization-state.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { type AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

type AccountLookup = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
};

type CachedAccountState = Readonly<{
  state: AdminAuthorizationAccountState;
  expiresAtMs: number;
}>;

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Injectable()
export class AdminAuthorizationStateService {
  private readonly accountCache = new Map<string, CachedAccountState>();
  private readonly accountLoads = new Map<
    string,
    Promise<AdminAuthorizationAccountState | null>
  >();

  constructor(
    @InjectModel(AdminAccount.name)
    private readonly adminAccountModel: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly adminSessionModel: Model<AdminSession>,
    @Inject(ADMIN_AUTHORIZATION_CLOCK)
    private readonly clock: AdminAuthorizationClock,
  ) {}

  async resolvePrincipal(
    input: ResolveAdminAuthorizationInput,
  ): Promise<AdminRequestPrincipal | null> {
    if (!this.isValidInput(input)) return null;

    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new ServiceUnavailableException(
        ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
      );
    }

    const [account, sessionActive] = await Promise.all([
      this.getAccountState(input.adminPublicId, nowMs),
      this.isSessionActive(input, nowMs),
    ]);

    if (
      !account ||
      !sessionActive ||
      account.credentialVersion !== input.credentialVersion ||
      account.authzVersion !== input.authzVersion ||
      account.permissionVersion !== input.permissionVersion
    ) {
      return null;
    }

    return Object.freeze({
      adminAccountId: account.adminAccountId,
      id: account.publicId,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      sessionId: input.sessionPublicId,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    });
  }

  invalidateAdminAccount(adminPublicId: string): void {
    if (!isValidAdminPublicId(adminPublicId)) return;
    this.accountCache.delete(adminPublicId);
  }

  private async getAccountState(
    adminPublicId: string,
    nowMs: number,
  ): Promise<AdminAuthorizationAccountState | null> {
    const cached = this.accountCache.get(adminPublicId);
    if (cached && nowMs < cached.expiresAtMs) {
      return cached.state;
    }
    if (cached) this.accountCache.delete(adminPublicId);

    const inFlight = this.accountLoads.get(adminPublicId);
    if (inFlight) return inFlight;

    const loadStartedAtMs = nowMs;
    const load = this.loadAccountState(adminPublicId);
    this.accountLoads.set(adminPublicId, load);

    try {
      const state = await load;
      if (state) this.cacheAccountState(state, loadStartedAtMs);
      return state;
    } finally {
      if (this.accountLoads.get(adminPublicId) === load) {
        this.accountLoads.delete(adminPublicId);
      }
    }
  }

  private async loadAccountState(
    adminPublicId: string,
  ): Promise<AdminAuthorizationAccountState | null> {
    let account: AccountLookup | null;

    try {
      account = await this.adminAccountModel
        .findOne({
          publicId: adminPublicId,
          status: AdminAccountStatus.ACTIVE,
          deletedAt: null,
          mustChangePassword: false,
          mfaStatus: AdminMfaStatus.ACTIVE,
        })
        .select(
          '_id publicId username displayName role ' +
            '+credentialVersion +authzVersion +permissionVersion',
        )
        .lean<AccountLookup | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrowInfrastructureFailure(error);
    }

    if (!this.isValidAccount(account)) return null;

    return Object.freeze({
      adminAccountId: account._id.toHexString(),
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    });
  }

  private async isSessionActive(
    input: ResolveAdminAuthorizationInput,
    nowMs: number,
  ): Promise<boolean> {
    try {
      const session = await this.adminSessionModel
        .findOne({
          adminPublicId: input.adminPublicId,
          publicId: input.sessionPublicId,
          revokedAt: null,
          expiresAt: { $gt: new Date(nowMs) },
        })
        .select('_id')
        .lean<{ _id: Types.ObjectId } | null>()
        .exec();

      return Boolean(session?._id);
    } catch (error: unknown) {
      this.rethrowInfrastructureFailure(error);
    }
  }

  private cacheAccountState(
    state: AdminAuthorizationAccountState,
    loadStartedAtMs: number,
  ): void {
    const observedAtMs = this.clock();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) return;

    const expiresAtMs =
      loadStartedAtMs + ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS;
    if (observedAtMs >= expiresAtMs) return;

    this.pruneCache(observedAtMs);
    this.accountCache.set(
      state.publicId,
      Object.freeze({
        state,
        expiresAtMs,
      }),
    );
  }

  private pruneCache(nowMs: number): void {
    for (const [key, entry] of this.accountCache) {
      if (nowMs >= entry.expiresAtMs) this.accountCache.delete(key);
    }

    while (
      this.accountCache.size >= ADMIN_AUTHORIZATION_ACCOUNT_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.accountCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.accountCache.delete(oldestKey);
    }
  }

  private isValidInput(input: ResolveAdminAuthorizationInput): boolean {
    return (
      isValidAdminPublicId(input.adminPublicId) &&
      ADMIN_SESSION_PUBLIC_ID_PATTERN.test(input.sessionPublicId) &&
      isNonNegativeInteger(input.credentialVersion) &&
      isNonNegativeInteger(input.authzVersion) &&
      isNonNegativeInteger(input.permissionVersion)
    );
  }

  private isValidAccount(value: AccountLookup | null): value is AccountLookup {
    return (
      Boolean(value) &&
      value?._id instanceof Types.ObjectId &&
      isValidAdminPublicId(value.publicId) &&
      typeof value.username === 'string' &&
      value.username.length > 0 &&
      typeof value.displayName === 'string' &&
      value.displayName.length > 0 &&
      (value.role === AdminRole.ADMIN ||
        value.role === AdminRole.SUPER_ADMIN) &&
      isNonNegativeInteger(value.credentialVersion) &&
      isNonNegativeInteger(value.authzVersion) &&
      isNonNegativeInteger(value.permissionVersion)
    );
  }

  private rethrowInfrastructureFailure(error: unknown): never {
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
      );
    }
    throw error;
  }
}
