// src/modules/auth/strategies/jwt.strategy.ts
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    // 1. Lấy giá trị từ ConfigService
    const jwtSecret = configService.get<string>('JWT_SECRET');

    // 2. KIỂM TRA CHUẨN DOANH NGHIỆP:
    // Nếu thiếu secret, ứng dụng phải báo lỗi ngay lập tức.
    if (!jwtSecret) {
      throw new Error(
        'CRITICAL ERROR: JWT_SECRET is not defined in .env file!',
      );
    }

    // 3. Gọi super() với giá trị chắc chắn là string (hết lỗi TypeScript)
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  // Payload là dữ liệu ta đã mã hóa vào token lúc Login
  async validate(payload: any) {
    // Trả về dữ liệu để gán vào req.user
    return { _id: payload.sub, email: payload.email };
  }
}
