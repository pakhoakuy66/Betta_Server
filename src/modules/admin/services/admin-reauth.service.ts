import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
} from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import {
  type AdminReauthGrantResult,
  type ConsumeAdminReauthGrantInput,
  type IssueAdminReauthGrantInput,
} from '../interfaces/admin-reauth.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminReauthGrant } from '../schemas/admin-reauth-grant.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import {
  generateAdminSecurityGrant,
  hashAdminReauthGrant,
} from '../utils/admin-security-grant';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminAuditService } from './admin-audit.service';
import { AdminLoginProtectionService } from './admin-login-protection.service';
import { AdminMfaService } from './admin-mfa.service';

type ReauthAccount = Pick<
  AdminAccount,
  | 'publicId'
  | 'passwordHash'
  | 'credentialVersion'
  | 'authzVersion'
  | 'permissionVersion'
> & { _id: Types.ObjectId };

@Injectable()
export class AdminReauthService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminSession.name)
    private readonly sessions: Model<AdminSession>,
    @InjectModel(AdminReauthGrant.name)
    private readonly grants: Model<AdminReauthGrant>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(ADMIN_POLICY) private readonly policy: AdminPolicy,
    private readonly mfa: AdminMfaService,
    private readonly audit: AdminAuditService,
    private readonly loginProtection: AdminLoginProtectionService,
  ) {}

  async issue(
    input: IssueAdminReauthGrantInput,
  ): Promise<AdminReauthGrantResult> {
    this.assertIssueInput(input);
    const identity = {
      accountKey: input.adminPublicId,
      trustedClientIp: input.trustedClientIp,
    };
    await this.loginProtection.assertAllowed(identity);
    let credentialProofRejected = false;
    try {
      const snapshot = await this.loadAccount(
        input.adminAccountId,
        input.adminPublicId,
      );
      const passwordMatches = Boolean(
        snapshot?.passwordHash &&
        (await bcrypt.compare(input.password, snapshot.passwordHash)),
      );
      if (!snapshot || !passwordMatches) {
        credentialProofRejected = true;
        throw this.unauthorized();
      }

      const rawGrant = generateAdminSecurityGrant();
      const grantHash = hashAdminReauthGrant({
        rawGrant,
        purpose: input.purpose,
        adminPublicId: input.adminPublicId,
        sessionPublicId: input.sessionPublicId,
        targetPublicId: input.targetPublicId,
      });
      const expiresAt = new Date(
        Date.now() + this.policy.reauthentication.grantTtlSeconds * 1_000,
      );

      await this.connection.transaction(async (mongoSession) => {
        const sessionActive = await this.sessions
          .exists({
            adminAccountId: snapshot._id,
            adminPublicId: snapshot.publicId,
            publicId: input.sessionPublicId,
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          })
          .session(mongoSession);
        if (!sessionActive) {
          credentialProofRejected = true;
          throw this.unauthorized();
        }

        const verified = await this.mfa.verifyTotpInTransaction(
          snapshot._id,
          snapshot.publicId,
          input.totpToken,
          mongoSession,
        );
        if (!verified) {
          credentialProofRejected = true;
          throw this.unauthorized();
        }

        const [created] = await this.grants.create(
          [
            {
              adminAccountId: snapshot._id,
              adminPublicId: snapshot.publicId,
              sessionPublicId: input.sessionPublicId,
              purpose: input.purpose,
              targetPublicId: input.targetPublicId,
              grantHash,
              credentialVersion: snapshot.credentialVersion,
              authzVersion: snapshot.authzVersion,
              permissionVersion: snapshot.permissionVersion,
              expiresAt,
              consumedAt: null,
            },
          ],
          { session: mongoSession },
        );
        await this.audit.record({
          action: AdminAuditAction.REAUTH_GRANT_ISSUED,
          outcome: AdminAuditOutcome.SUCCEEDED,
          actor: input.actor,
          target: {
            type: AdminAuditTargetType.REAUTH_GRANT,
            publicId: created.publicId,
          },
          reasonCode: input.purpose,
          source: input.source,
          mongoSession,
        });
        await this.loginProtection.clearAccountFailuresInTransaction(
          snapshot.publicId,
          mongoSession,
        );
      });
      return Object.freeze({ grant: rawGrant, expiresAt });
    } catch (error: unknown) {
      if (credentialProofRejected) {
        await this.loginProtection.recordFailure(identity);
      }
      this.rethrow(error);
    }
  }

  async consumeInTransaction(
    input: ConsumeAdminReauthGrantInput,
  ): Promise<void> {
    this.assertConsumeInput(input);
    this.assertTransaction(input.mongoSession);
    const now = new Date();
    const grantHash = hashAdminReauthGrant({
      rawGrant: input.rawGrant,
      purpose: input.purpose,
      adminPublicId: input.adminPublicId,
      sessionPublicId: input.sessionPublicId,
      targetPublicId: input.targetPublicId,
    });

    // The caller owns the transaction and must receive MongoDB retry labels.
    const sessionActive = await this.sessions
      .exists({
        adminAccountId: input.adminAccountId,
        adminPublicId: input.adminPublicId,
        publicId: input.sessionPublicId,
        revokedAt: null,
        expiresAt: { $gt: now },
      })
      .session(input.mongoSession);
    if (!sessionActive) throw this.unauthorized();

    const consumed = await this.grants.findOneAndUpdate(
      {
        adminAccountId: input.adminAccountId,
        adminPublicId: input.adminPublicId,
        sessionPublicId: input.sessionPublicId,
        purpose: input.purpose,
        targetPublicId: input.targetPublicId,
        grantHash,
        credentialVersion: input.credentialVersion,
        authzVersion: input.authzVersion,
        permissionVersion: input.permissionVersion,
        consumedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      { returnDocument: 'after', session: input.mongoSession },
    );
    if (!consumed) throw this.unauthorized();

    await this.audit.record({
      action: AdminAuditAction.REAUTH_GRANT_CONSUMED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: input.actor,
      target: {
        type: AdminAuditTargetType.REAUTH_GRANT,
        publicId: consumed.publicId,
      },
      reasonCode: input.purpose,
      source: input.source,
      mongoSession: input.mongoSession,
    });
  }

  private async loadAccount(
    id: Types.ObjectId,
    publicId: string,
  ): Promise<ReauthAccount | null> {
    try {
      return await this.accounts
        .findOne({
          _id: id,
          publicId,
          status: AdminAccountStatus.ACTIVE,
          mfaStatus: AdminMfaStatus.ACTIVE,
          mustChangePassword: false,
          deletedAt: null,
        })
        .select(
          '_id publicId +passwordHash +credentialVersion +authzVersion +permissionVersion',
        )
        .lean<ReauthAccount | null>()
        .exec();
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  private assertIssueInput(input: IssueAdminReauthGrantInput): void {
    if (
      !Types.ObjectId.isValid(input.adminAccountId) ||
      !isValidAdminPublicId(input.adminPublicId) ||
      typeof input.password !== 'string' ||
      input.password.length > 64 ||
      !Object.values(AdminReauthPurpose).includes(input.purpose)
    ) {
      throw new TypeError('Admin re-auth input không hợp lệ');
    }
    hashAdminReauthGrant({
      rawGrant: generateAdminSecurityGrant(),
      purpose: input.purpose,
      adminPublicId: input.adminPublicId,
      sessionPublicId: input.sessionPublicId,
      targetPublicId: input.targetPublicId,
    });
  }

  private assertConsumeInput(input: ConsumeAdminReauthGrantInput): void {
    if (
      !Types.ObjectId.isValid(input.adminAccountId) ||
      !Number.isSafeInteger(input.credentialVersion) ||
      !Number.isSafeInteger(input.authzVersion) ||
      !Number.isSafeInteger(input.permissionVersion) ||
      input.permissionVersion < 1
    ) {
      throw new TypeError('Admin re-auth consume input không hợp lệ');
    }
  }

  private assertTransaction(session: ClientSession): void {
    if (session?.inTransaction() !== true) {
      throw new TypeError('Admin re-auth consume yêu cầu transaction active');
    }
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException(
      'Xác thực lại không hợp lệ hoặc đã hết hạn',
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof UnauthorizedException || error instanceof TypeError) {
      throw error;
    }
    if (isMongoInfrastructureError(error)) {
      throw new ServiceUnavailableException(
        'Dịch vụ xác thực lại Admin tạm thời không khả dụng',
      );
    }
    throw error;
  }
}
