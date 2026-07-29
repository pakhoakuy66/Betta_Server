import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, type Model } from 'mongoose';
import { isEmail } from 'class-validator';

import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  USER_STATUS,
  User,
} from '../../users/schemas/user.schema';
import { generateUserPublicId } from '../../users/utils/generate-public-id';
import {
  GOOGLE_REGISTRATION_FULLNAME_PATTERN,
  GOOGLE_REGISTRATION_PHONE_PATTERN,
  GOOGLE_REGISTRATION_USERNAME_PATTERN,
  type CompleteGoogleOAuthRegistrationDto,
} from '../dto/complete-google-oauth-registration.dto';
import type { AuthResponse } from '../interfaces/auth.interface';
import type { SessionRequestMetadata } from '../interfaces/auth-session.interface';
import { AuthSessionService } from './auth-session.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { OAuthIdentityService } from './oauth-identity.service';
import { toPublicAuthUser } from '../mappers/public-auth-user.mapper';

const REGISTRATION_CONFLICT_MESSAGE =
  'Thông tin đăng ký Google đã được sử dụng';

const REGISTRATION_UNAVAILABLE_MESSAGE =
  'Không thể hoàn tất đăng ký Google, vui lòng thử lại';

const INVALID_PROFILE_MESSAGE = 'Thông tin đăng ký Google không hợp lệ';

type DuplicateKeyError = {
  code?: unknown;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
};

@Injectable()
export class GoogleOAuthRegistrationService {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly continuationGrantService: GoogleOAuthContinuationGrantService,

    private readonly oauthIdentityService: OAuthIdentityService,

    private readonly authSessionService: AuthSessionService,
  ) {}

  async completeRegistration(
    rawGrant: string,
    input: CompleteGoogleOAuthRegistrationDto,
    metadata: SessionRequestMetadata,
  ): Promise<AuthResponse> {
    const username = this.requireUsername(input.username);
    const phone = this.requirePhone(input.phone);
    const suppliedFullname =
      input.fullname === undefined
        ? null
        : this.requireFullname(input.fullname);

    try {
      return await this.connection.transaction(async (mongoSession) =>
        this.completeInsideTransaction(
          rawGrant,
          username,
          phone,
          suppliedFullname,
          metadata,
          mongoSession,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (this.isDuplicateKey(error)) {
        if (this.isRegistrationDataConflict(error)) {
          throw new ConflictException(REGISTRATION_CONFLICT_MESSAGE);
        }

        throw new ServiceUnavailableException(REGISTRATION_UNAVAILABLE_MESSAGE);
      }

      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(REGISTRATION_UNAVAILABLE_MESSAGE);
      }

      throw error;
    }
  }

  private async completeInsideTransaction(
    rawGrant: string,
    username: string,
    phone: string,
    suppliedFullname: string | null,
    metadata: SessionRequestMetadata,
    mongoSession: ClientSession,
  ): Promise<AuthResponse> {
    const grant = await this.continuationGrantService.consumeRegistrationGrant(
      rawGrant,
      mongoSession,
    );

    const email = normalizeAuthEmail(grant.email);

    if (!isEmail(email)) {
      throw new BadRequestException(INVALID_PROFILE_MESSAGE);
    }

    const fullname = this.normalizeFullname(grant.fullname) ?? suppliedFullname;

    if (!fullname) {
      throw new BadRequestException('Vui lòng cung cấp họ tên');
    }

    const duplicateUser = await this.userModel
      .findOne({
        $or: [{ email }, { username }, { phone }],
      })
      .select({ _id: 1 })
      .session(mongoSession)
      .lean()
      .exec();

    if (duplicateUser) {
      throw new ConflictException(REGISTRATION_CONFLICT_MESSAGE);
    }

    const linkedUserId = await this.oauthIdentityService.resolveGoogleUserId(
      grant.providerAccountId,
      mongoSession,
    );

    if (linkedUserId) {
      throw new ConflictException(REGISTRATION_CONFLICT_MESSAGE);
    }

    const [user] = await this.userModel.create(
      [
        {
          publicId: generateUserPublicId(),
          username,
          fullname,
          email,
          phone,
          avatar: this.normalizeAvatar(grant.avatar) ?? DEFAULT_AVATAR_URL,
          avatarId: DEFAULT_AVATAR_ID,
          status: USER_STATUS.ACTIVE,
          isDeleted: false,
        },
      ],
      {
        session: mongoSession,
      },
    );

    if (!user) {
      throw new ServiceUnavailableException(REGISTRATION_UNAVAILABLE_MESSAGE);
    }

    await this.oauthIdentityService.createGoogleIdentity(
      user._id,
      grant.providerAccountId,
      mongoSession,
    );

    const tokens = await this.authSessionService.createSession(
      user,
      metadata,
      mongoSession,
    );

    return {
      message: 'Đăng ký bằng Google thành công',
      ...tokens,
      user: toPublicAuthUser(user),
    };
  }

  private requireUsername(value: unknown): string {
    const username = typeof value === 'string' ? value.trim() : '';

    if (
      username.length < 1 ||
      username.length > 30 ||
      !GOOGLE_REGISTRATION_USERNAME_PATTERN.test(username)
    ) {
      throw new BadRequestException(INVALID_PROFILE_MESSAGE);
    }

    return username;
  }

  private requirePhone(value: unknown): string {
    const phone = typeof value === 'string' ? value.trim() : '';

    if (!GOOGLE_REGISTRATION_PHONE_PATTERN.test(phone)) {
      throw new BadRequestException(INVALID_PROFILE_MESSAGE);
    }

    return phone;
  }

  private normalizeFullname(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const fullname = value.trim();

    if (
      fullname.length < 1 ||
      fullname.length > 200 ||
      !GOOGLE_REGISTRATION_FULLNAME_PATTERN.test(fullname)
    ) {
      return null;
    }

    return fullname;
  }

  private requireFullname(value: unknown): string {
    const fullname = this.normalizeFullname(value);

    if (!fullname) {
      throw new BadRequestException(INVALID_PROFILE_MESSAGE);
    }

    return fullname;
  }

  private normalizeAvatar(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2_048) {
      return null;
    }

    try {
      const url = new URL(value);

      if (url.protocol !== 'https:' || url.username || url.password) {
        return null;
      }

      return url.toString();
    } catch {
      return null;
    }
  }

  private isDuplicateKey(error: unknown): error is DuplicateKeyError {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const code = (error as DuplicateKeyError).code;

    return code === 11000 || code === '11000';
  }

  private isRegistrationDataConflict(error: DuplicateKeyError): boolean {
    const fields = new Set([
      ...Object.keys(error.keyPattern ?? {}),
      ...Object.keys(error.keyValue ?? {}),
    ]);

    return fields.has('email') || fields.has('username') || fields.has('phone');
  }
}
