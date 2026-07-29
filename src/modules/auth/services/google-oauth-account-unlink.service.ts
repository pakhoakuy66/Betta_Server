import {
  ConflictException,
  HttpException,
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
import { USER_STATUS, User } from '../../users/schemas/user.schema';
import { PASSWORD_MAX_LENGTH } from '../constants/password-policy';
import { GoogleOAuthAccountUnlinkUnavailableException } from '../exceptions/google-oauth-account-unlink-unavailable.exception';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import { AuthAuditService } from './auth-audit.service';
import { OAuthIdentityService } from './oauth-identity.service';

const LAST_LOGIN_METHOD_MESSAGE =
  'Hãy thiết lập mật khẩu trước khi hủy liên kết Google';

const INVALID_PASSWORD_MESSAGE = 'Mật khẩu không chính xác';

const INFRASTRUCTURE_ERROR_MESSAGE = 'Không thể hoàn tất thao tác bảo mật';

type PasswordUserRecord = {
  _id: Types.ObjectId;
  password?: string;
};

type ClaimedUserRecord = {
  _id: Types.ObjectId;
};

type EligibleUserFilter = {
  _id: Types.ObjectId;
  isDeleted: false;
  status: typeof USER_STATUS.ACTIVE;
  $or: Array<
    | {
        lockedUntil: null;
      }
    | {
        lockedUntil: {
          $lte: Date;
        };
      }
    | {
        lockedUntil: {
          $exists: false;
        };
      }
  >;
};

@Injectable()
export class GoogleOAuthAccountUnlinkService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly identityService: OAuthIdentityService,

    private readonly auditService: AuthAuditService,
  ) {}

  async unlinkGoogleAccount(
    authenticatedUserId: Types.ObjectId,
    currentPassword: string,
  ): Promise<void> {
    this.validateInput(authenticatedUserId, currentPassword);

    try {
      const expectedPasswordHash = await this.verifyCurrentPassword(
        authenticatedUserId,
        currentPassword,
      );

      await this.connection.transaction(async (mongoSession) => {
        await this.unlinkInsideTransaction(
          authenticatedUserId,
          expectedPasswordHash,
          mongoSession,
        );
      });
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(INFRASTRUCTURE_ERROR_MESSAGE);
      }

      throw error;
    }
  }

  private async verifyCurrentPassword(
    userId: Types.ObjectId,
    currentPassword: string,
  ): Promise<string> {
    const user = await this.userModel
      .findOne(this.createEligibleUserFilter(userId, new Date()))
      .select('_id +password')
      .lean<PasswordUserRecord | null>()
      .exec();

    if (!user) {
      throw new GoogleOAuthAccountUnlinkUnavailableException();
    }

    if (!user.password) {
      throw new ConflictException(LAST_LOGIN_METHOD_MESSAGE);
    }

    const passwordMatches = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_PASSWORD_MESSAGE);
    }

    return user.password;
  }

  private async unlinkInsideTransaction(
    userId: Types.ObjectId,
    expectedPasswordHash: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    const now = new Date();

    const claimedUser = await this.userModel
      .findOneAndUpdate(
        {
          ...this.createEligibleUserFilter(userId, now),
          password: expectedPasswordHash,
        },
        {
          // Force a user-document write so concurrent unlink and account
          // mutations conflict and are revalidated by the transaction.
          $set: {
            updatedAt: now,
          },
        },
        {
          returnDocument: 'after',
          projection: {
            _id: 1,
          },
          session: mongoSession,
        },
      )
      .lean<ClaimedUserRecord | null>()
      .exec();

    if (!claimedUser) {
      throw new GoogleOAuthAccountUnlinkUnavailableException();
    }

    const identityDeleted = await this.identityService.deleteGoogleIdentity(
      claimedUser._id,
      mongoSession,
    );

    if (!identityDeleted) {
      throw new GoogleOAuthAccountUnlinkUnavailableException();
    }

    await this.auditService.record({
      eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_UNLINKED,
      targetUserId: claimedUser._id,
      actorUserId: userId,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
      mongoSession,
    });
  }

  private createEligibleUserFilter(
    userId: Types.ObjectId,
    now: Date,
  ): EligibleUserFilter {
    return {
      _id: userId,
      isDeleted: false,
      status: USER_STATUS.ACTIVE,
      $or: [
        {
          lockedUntil: null,
        },
        {
          lockedUntil: {
            $lte: now,
          },
        },
        {
          lockedUntil: {
            $exists: false,
          },
        },
      ],
    };
  }

  private validateInput(userId: Types.ObjectId, currentPassword: string): void {
    if (!(userId instanceof Types.ObjectId)) {
      throw new TypeError('authenticatedUserId must be a MongoDB ObjectId');
    }

    if (
      typeof currentPassword !== 'string' ||
      currentPassword.length === 0 ||
      currentPassword.length > PASSWORD_MAX_LENGTH
    ) {
      throw new TypeError('currentPassword is invalid');
    }
  }
}
