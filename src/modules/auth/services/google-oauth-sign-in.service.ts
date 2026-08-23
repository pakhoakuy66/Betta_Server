import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type Connection, type Model, Types } from 'mongoose';

import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { USER_STATUS, User } from '../../users/schemas/user.schema';
import type { AuthResponse } from '../interfaces/auth.interface';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';
import { GoogleOAuthSessionHandoffService } from './google-oauth-session-handoff.service';
import type { SessionRequestMetadata } from '../interfaces/auth-session.interface';
import {
  GOOGLE_SUBJECT_MAX_LENGTH,
  GOOGLE_SUBJECT_PATTERN,
} from '../schemas/oauth-identity.schema';
import { toPublicAuthUser } from '../mappers/public-auth-user.mapper';
import { AuthSessionService } from './auth-session.service';
import { OAuthIdentityService } from './oauth-identity.service';
import { AccountRestrictedException } from '../exceptions/account-restricted.exception';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { isActiveUserRestriction } from '../../users/utils/user-restriction';
import type { UserRestriction } from '../../users/schemas/user.schema';
import { AdminUserRestrictionExpiryService } from '../../admin/services/admin-user-restriction-expiry.service';

const ACCOUNT_UNAVAILABLE_MESSAGE = 'Tài khoản không tồn tại hoặc đã bị khóa';

const ACCOUNT_LOCKED_MESSAGE =
  'Tài khoản đang tạm thời bị khóa. Vui lòng thử lại sau';

const AUTHENTICATED_USER_SELECTION = [
  '_id',
  'publicId',
  'username',
  'fullname',
  'email',
  'phone',
  'avatar',
  'avatarId',
  'streakCount',
  'status',
  'notificationSettings',
  '+authzVersion',
  '+version',
  '+restriction',
].join(' ');

type AuthenticatedGoogleUser = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar?: string;
  avatarId?: string;
  streakCount?: number;
  status?: typeof USER_STATUS.ACTIVE;
  notificationSettings?: User['notificationSettings'];
  authzVersion: number;
  version: number;
  restriction: UserRestriction | null;
};

type AccountState = {
  isDeleted: boolean;
  status: User['status'];
  lockedUntil?: Date | null;
  restriction: UserRestriction | null;
};

type SignInTransactionResult =
  | {
      outcome: 'SUCCEEDED';
      handoff: IssuedGoogleOAuthSessionHandoff;
    }
  | {
      outcome: 'IDENTITY_REJECTED';
    }
  | {
      outcome: 'ACCOUNT_REJECTED';
    };

@Injectable()
export class GoogleOAuthSignInService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly oauthIdentityService: OAuthIdentityService,

    private readonly authSessionService: AuthSessionService,

    private readonly sessionHandoffService: GoogleOAuthSessionHandoffService,

    private readonly restrictionExpiryService: AdminUserRestrictionExpiryService,
  ) {}

  async signInLinkedAccount(
    providerAccountId: string,
    expectedUserId: Types.ObjectId,
    metadata: SessionRequestMetadata,
  ): Promise<IssuedGoogleOAuthSessionHandoff> {
    this.assertInput(providerAccountId, expectedUserId);

    try {
      const result = await this.connection.transaction<SignInTransactionResult>(
        async (mongoSession) => {
          const linkedUserId =
            await this.oauthIdentityService.resolveGoogleUserId(
              providerAccountId,
              mongoSession,
            );

          if (!linkedUserId || !linkedUserId.equals(expectedUserId)) {
            return {
              outcome: 'IDENTITY_REJECTED',
            };
          }

          const now = new Date();

          const user = await this.userModel
            .findOneAndUpdate(
              {
                _id: expectedUserId,
                isDeleted: false,
                status: USER_STATUS.ACTIVE,
                $and: [
                  {
                    $or: [
                      { lockedUntil: null },
                      { lockedUntil: { $lte: now } },
                    ],
                  },
                  {
                    $or: [
                      { restriction: null },
                      { restriction: { $exists: false } },
                      {
                        'restriction.type':
                          UserRestrictionType.TEMPORARY_SUSPENSION,
                        'restriction.expiresAt': { $lte: now },
                      },
                    ],
                  },
                ],
              },
              {
                $set: {
                  failedLoginAttempts: 0,
                },
                $unset: {
                  failedLoginWindowStartedAt: '',
                  lockedUntil: '',
                },
              },
              {
                session: mongoSession,
                returnDocument: 'after',
                runValidators: true,
              },
            )
            .select(AUTHENTICATED_USER_SELECTION)
            .lean<AuthenticatedGoogleUser | null>()
            .exec();

          if (!user) {
            return {
              outcome: 'ACCOUNT_REJECTED',
            };
          }

          const expiry =
            await this.restrictionExpiryService.convergeForAuthentication(
              user._id,
              now,
              mongoSession,
            );
          if (expiry) {
            user.restriction = null;
            user.version = expiry.afterVersion;
            user.authzVersion = expiry.authzVersion;
          }

          const tokens = await this.authSessionService.createSession(
            user,
            metadata,
            mongoSession,
          );

          const authResponse: AuthResponse = {
            message: 'Đăng nhập bằng Google thành công',
            ...tokens,
            user: toPublicAuthUser(user),
          };

          const handoff = await this.sessionHandoffService.issue(
            authResponse,
            mongoSession,
          );

          return {
            outcome: 'SUCCEEDED',
            handoff,
          };
        },
      );

      if (result.outcome === 'IDENTITY_REJECTED') {
        throw this.accountUnavailable();
      }

      if (result.outcome === 'ACCOUNT_REJECTED') {
        await this.throwIfAccountRejected(expectedUserId);
        throw this.accountUnavailable();
      }

      return result.handoff;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể hoàn tất đăng nhập Google',
        );
      }

      throw error;
    }
  }

  private async throwIfAccountRejected(userId: Types.ObjectId): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('isDeleted status +lockedUntil +restriction')
      .lean<AccountState | null>()
      .exec();

    if (!user || user.isDeleted) return;

    if (isActiveUserRestriction(user.restriction)) {
      throw new AccountRestrictedException(user.restriction);
    }

    if (
      user.status !== USER_STATUS.ACTIVE ||
      !user.lockedUntil ||
      user.lockedUntil.getTime() <= Date.now()
    ) {
      return;
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1_000),
    );

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: ACCOUNT_LOCKED_MESSAGE,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private assertInput(
    providerAccountId: string,
    expectedUserId: Types.ObjectId,
  ): void {
    if (!(expectedUserId instanceof Types.ObjectId)) {
      throw new TypeError('expectedUserId must be a MongoDB ObjectId');
    }

    if (
      typeof providerAccountId !== 'string' ||
      providerAccountId.length === 0 ||
      providerAccountId.length > GOOGLE_SUBJECT_MAX_LENGTH ||
      !GOOGLE_SUBJECT_PATTERN.test(providerAccountId)
    ) {
      throw new TypeError('Invalid Google subject');
    }
  }

  private accountUnavailable(): UnauthorizedException {
    return new UnauthorizedException(ACCOUNT_UNAVAILABLE_MESSAGE);
  }
}
