import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { JwtRequestUser } from '../../../common/types/authenticated-request';
import { User } from '../../users/schemas/user.schema';
import type { AccessTokenPayload } from '../interfaces/auth-session.interface';
import { AuthSessionService } from '../services/auth-session.service';
import { AccountRestrictedException } from '../exceptions/account-restricted.exception';
import { isActiveUserRestriction } from '../../users/utils/user-restriction';
import type { UserRestriction } from '../../users/schemas/user.schema';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
} from '../constants/auth-token.constants';

type JwtUserLookup = {
  _id: Types.ObjectId;
  email: string;
  username: string;
  authzVersion: number;
  restriction: UserRestriction | null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly authSessionService: AuthSessionService,
  ) {
    const rawSecret = configService.get<unknown>('JWT_SECRET');

    if (typeof rawSecret !== 'string') {
      throw new Error('JWT_SECRET phải là chuỗi');
    }

    const secret = rawSecret.trim();

    if (secret.length < 32) {
      throw new Error('JWT_SECRET phải có tối thiểu 32 ký tự');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      issuer: AUTH_JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: [AUTH_JWT_ALGORITHM],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<JwtRequestUser> {
    const validSessionId =
      typeof payload.sid === 'string' &&
      payload.sid.startsWith('ses_') &&
      payload.sid.length >= 20 &&
      payload.sid.length <= 64;

    if (
      payload.tokenUse !== 'access' ||
      !Types.ObjectId.isValid(payload.sub) ||
      !validSessionId ||
      !Number.isSafeInteger(payload.authzVersion) ||
      payload.authzVersion < 0
    ) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    const userId = new Types.ObjectId(payload.sub);

    let user: JwtUserLookup | null;
    let sessionActive: boolean;
    try {
      [user, sessionActive] = await Promise.all([
        this.userModel
          .findOne({ _id: userId, isDeleted: false, status: 'active' })
          .select('_id email username +authzVersion +restriction')
          .lean<JwtUserLookup | null>()
          .exec(),
        this.authSessionService.isSessionActive(userId, payload.sid),
      ]);
    } catch (error: unknown) {
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Dịch vụ xác thực tạm thời không khả dụng',
        );
      }
      throw error;
    }

    if (!user || !sessionActive || user.authzVersion !== payload.authzVersion) {
      throw new UnauthorizedException('Phiên đăng nhập không còn hợp lệ');
    }

    if (isActiveUserRestriction(user.restriction)) {
      throw new AccountRestrictedException(user.restriction);
    }

    const id = user._id.toString();

    return {
      _id: id,
      id,
      email: user.email,
      username: user.username,
      sessionId: payload.sid,
    };
  }
}
