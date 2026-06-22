// auth.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './services/auth.service';
import { MailService } from './services/mail.service';
import { AuthController } from './controllers/auth.controller';
import { User, UserSchema } from '../users/schemas/user.schema'; // Đảm bảo đúng đường dẫn
import { JwtStrategy } from './strategies/jwt.strategy';
import {
  AuthRateLimit,
  AuthRateLimitSchema,
} from './schemas/auth-rate-limit.schema';
import { AuthRateLimitService } from './services/auth-rate-limit.service';

@Module({
  imports: [
    // BỔ SUNG DÒNG NÀY: Đăng ký Model User cho riêng AuthModule sử dụng
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthRateLimit.name, schema: AuthRateLimitSchema },
    ]),
    PassportModule,
    // Cấu hình JwtModule động từ file .env
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        // signOptions: { expiresIn: '1d' }, // Mặc định giá trị nếu Không ghi đè
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRateLimitService, JwtStrategy, MailService],
})
export class AuthModule {}
