import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { JwtRequestUser } from '../../../common/types/authenticated-request';
import { User } from '../../users/schemas/user.schema';

type JwtPayload = {
  sub: string;
  email?: string;
  username?: string;
};

type JwtUserLookup = {
  _id: Types.ObjectId;
  email?: string;
  username?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {
    const jwtSecret = configService.get<string>('JWT_SECRET');

    if (!jwtSecret) {
      throw new Error(
        'CRITICAL ERROR: JWT_SECRET is not defined in .env file!',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtRequestUser> {
    if (!payload.sub || !Types.ObjectId.isValid(payload.sub)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    const user = await this.userModel
      .findOne({
        _id: new Types.ObjectId(payload.sub),
        isDeleted: false,
        status: 'active',
      })
      .select('_id email username')
      .lean<JwtUserLookup>()
      .exec();

    if (!user) {
      throw new UnauthorizedException('Phiên đăng nhập không còn hợp lệ');
    }

    const userId = user._id.toString();

    return {
      _id: userId,
      id: userId,
      email: user.email,
      username: user.username,
    };
  }
}
