import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import {
  USER_STATUS,
  User,
  type UserStatus,
} from '../../users/schemas/user.schema';
import {
  GOOGLE_OAUTH_INTERNAL_USER_ID,
  type GoogleOAuthInternalAccountResolution,
  GoogleOAuthAccountResolutionStatus,
  type GoogleOAuthSignInResolution,
} from '../interfaces/google-oauth-account-resolution.interface';
import type { GoogleOAuthVerifiedIdentity } from '../interfaces/google-oauth-provider.interface';
import { OAuthIdentityService } from './oauth-identity.service';

const ACCOUNT_UNAVAILABLE_MESSAGE = 'Tài khoản không tồn tại hoặc đã bị khóa';

const ACCOUNT_LOCKED_MESSAGE =
  'Quá nhiều lần đăng nhập không thành công. Vui lòng thử lại sau.';

type AccountRecord = {
  _id: Types.ObjectId;
  isDeleted: boolean;
  status: UserStatus;
  lockedUntil?: Date | null;
};

@Injectable()
export class GoogleOAuthAccountResolverService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly oauthIdentityService: OAuthIdentityService,
  ) {}

  async resolve(
    identity: GoogleOAuthVerifiedIdentity,
  ): Promise<GoogleOAuthInternalAccountResolution> {
    const email = normalizeAuthEmail(identity.email);

    /*
     * Resolver vẫn kiểm tra lại vì đây là security boundary
     * nội bộ, dù provider đã validate email trước đó.
     */
    if (!email) {
      throw new TypeError('Verified Google identity requires an email');
    }

    const linkedUserId = await this.oauthIdentityService.resolveGoogleUserId(
      identity.providerAccountId,
    );

    if (linkedUserId) {
      return this.resolveLinkedUser(linkedUserId);
    }

    /*
     * Tìm cả account inactive vì email vẫn được unique index giữ.
     * Account unavailable không được chuyển thành đăng ký mới.
     */
    const existingUser = await this.userModel
      .findOne({ email })
      .select('_id isDeleted status +lockedUntil')
      .lean<AccountRecord | null>()
      .exec();

    if (existingUser) {
      this.assertAccountAvailable(existingUser);

      return {
        status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,

        email,

        [GOOGLE_OAUTH_INTERNAL_USER_ID]: existingUser._id,
      };
    }

    return {
      status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
      profile: {
        email,
        fullname: identity.fullname,
        avatar: identity.avatar,
      },
    };
  }

  private async resolveLinkedUser(
    linkedUserId: Types.ObjectId,
  ): Promise<GoogleOAuthSignInResolution> {
    const user = await this.userModel
      .findById(linkedUserId)
      .select('_id isDeleted status +lockedUntil')
      .lean<AccountRecord | null>()
      .exec();

    if (!user) {
      throw this.accountUnavailable();
    }

    /*
     * Dangling identity phải fail-closed.
     * Không fallback sang email hoặc registration.
     */
    this.assertAccountAvailable(user);

    return {
      status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
      [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
    };
  }

  private assertAccountAvailable(user: AccountRecord): void {
    if (user.isDeleted || user.status !== USER_STATUS.ACTIVE) {
      throw this.accountUnavailable();
    }

    const now = Date.now();

    /*
     * Giữ nguyên contract hiện tại:
     * account lock chặn mọi phương thức đăng nhập.
     */
    if (user.lockedUntil && user.lockedUntil.getTime() > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - now) / 1_000),
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
  }

  private accountUnavailable(): UnauthorizedException {
    return new UnauthorizedException(ACCOUNT_UNAVAILABLE_MESSAGE);
  }
}
