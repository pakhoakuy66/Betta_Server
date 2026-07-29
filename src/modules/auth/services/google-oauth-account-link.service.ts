import {
  ConflictException,
  HttpException,
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
import { USER_STATUS, User } from '../../users/schemas/user.schema';
import { GoogleOAuthAccountLinkUnavailableException } from '../exceptions/google-oauth-account-link-unavailable.exception';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import { AuthAuditService } from './auth-audit.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { OAuthIdentityService } from './oauth-identity.service';

const LINK_CONFLICT_MESSAGE = 'Không thể liên kết tài khoản Google';

const INFRASTRUCTURE_ERROR_MESSAGE = 'Không thể hoàn tất thao tác bảo mật';

type LinkableUserRecord = {
  _id: Types.ObjectId;
};

@Injectable()
export class GoogleOAuthAccountLinkService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly continuationGrantService: GoogleOAuthContinuationGrantService,

    private readonly oauthIdentityService: OAuthIdentityService,

    private readonly authAuditService: AuthAuditService,
  ) {}

  async linkGoogleAccount(
    rawGrant: string,
    authenticatedUserId: Types.ObjectId,
  ): Promise<void> {
    if (!(authenticatedUserId instanceof Types.ObjectId)) {
      throw new TypeError('authenticatedUserId must be a MongoDB ObjectId');
    }

    try {
      await this.connection.transaction(async (mongoSession) => {
        await this.linkInsideTransaction(
          rawGrant,
          authenticatedUserId,
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

  private async linkInsideTransaction(
    rawGrant: string,
    authenticatedUserId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<void> {
    const grant = await this.continuationGrantService.consumeLinkGrant(
      rawGrant,
      authenticatedUserId,
      mongoSession,
    );

    const now = new Date();

    /*
     * UserSchema bật timestamps. Việc cập nhật updatedAt là write
     * barrier để serialize thao tác link với ban/report/delete/lock.
     */
    const targetUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: authenticatedUserId,
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
        },
        {
          $set: {
            updatedAt: now,
          },
        },
        {
          returnDocument: 'after',
          session: mongoSession,
          projection: {
            _id: 1,
          },
        },
      )
      .lean<LinkableUserRecord | null>()
      .exec();

    if (!targetUser) {
      throw new GoogleOAuthAccountLinkUnavailableException();
    }

    const hasConflict = await this.oauthIdentityService.hasGoogleLinkConflict(
      targetUser._id,
      grant.providerAccountId,
      mongoSession,
    );

    if (hasConflict) {
      throw new ConflictException(LINK_CONFLICT_MESSAGE);
    }

    await this.oauthIdentityService.createGoogleIdentity(
      targetUser._id,
      grant.providerAccountId,
      mongoSession,
    );

    await this.authAuditService.record({
      eventCode: AuthAuditEventCode.OAUTH_LINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
      targetUserId: targetUser._id,
      actorUserId: authenticatedUserId,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
      mongoSession,
    });
  }
}
