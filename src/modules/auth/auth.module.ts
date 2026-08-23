// auth.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './services/auth.service';
import { MailService } from './services/mail.service';
import { AuthSessionService } from './services/auth-session.service';
import { AuthController } from './controllers/auth.controller';
import { AuthSessionsController } from './controllers/auth-sessions.controller';
import { User, UserSchema } from '../users/schemas/user.schema'; // Đảm bảo đúng đường dẫn
import { AuthSession, AuthSessionSchema } from './schemas/auth-session.schema';
import { JwtStrategy } from './strategies/jwt.strategy';
import {
  AuthRateLimit,
  AuthRateLimitSchema,
} from './schemas/auth-rate-limit.schema';
import {
  AuthAuditEvent,
  AuthAuditEventSchema,
} from './schemas/auth-audit-event.schema';
import { AuthAuditService } from './services/auth-audit.service';
import { AuthRateLimitService } from './services/auth-rate-limit.service';
import {
  OAuthIdentity,
  OAuthIdentitySchema,
} from './schemas/oauth-identity.schema';
import { OAuthIdentityService } from './services/oauth-identity.service';
import {
  GoogleOAuthTransaction,
  GoogleOAuthTransactionSchema,
} from './schemas/google-oauth-transaction.schema';
import { GoogleOAuthTransactionService } from './services/google-oauth-transaction.service';
import { GoogleOAuthClientFactory } from './services/google-oauth-client.factory';
import { GoogleOAuthProviderService } from './services/google-oauth-provider.service';
import { GoogleOAuthAccountResolverService } from './services/google-oauth-account-resolver.service';
import {
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantSchema,
} from './schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationGrantService } from './services/google-oauth-continuation-grant.service';
import { GoogleOAuthAccountLinkService } from './services/google-oauth-account-link.service';
import { GoogleOAuthAccountUnlinkService } from './services/google-oauth-account-unlink.service';
import { GoogleOAuthRegistrationService } from './services/google-oauth-registration.service';
import { GoogleOAuthContinuationCookieService } from './services/google-oauth-continuation-cookie.service';
import { GoogleOAuthContinuationController } from './controllers/google-oauth-continuation.controller';
import { GoogleOAuthContinuationOriginGuard } from './guards/google-oauth-continuation-origin.guard';
import { GoogleOAuthStateCookieService } from './services/google-oauth-state-cookie.service';
import { GoogleOAuthSignInService } from './services/google-oauth-sign-in.service';
import { GoogleOAuthCallbackService } from './services/google-oauth-callback.service';
import { GoogleOAuthAuthorizationController } from './controllers/google-oauth-authorization.controller';
import {
  GoogleOAuthSessionHandoff,
  GoogleOAuthSessionHandoffSchema,
} from './schemas/google-oauth-session-handoff.schema';
import { GoogleOAuthSessionHandoffService } from './services/google-oauth-session-handoff.service';
import { GoogleOAuthSessionHandoffCookieService } from './services/google-oauth-session-handoff-cookie.service';
import { GoogleOAuthCallbackController } from './controllers/google-oauth-callback.controller';
import { GoogleOAuthSessionController } from './controllers/google-oauth-session.controller';
import { GoogleOAuthFrontendRedirectService } from './services/google-oauth-frontend-redirect.service';
import { GoogleOAuthAccountController } from './controllers/google-oauth-account.controller';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    AdminModule,
    // BỔ SUNG DÒNG NÀY: Đăng ký Model User cho riêng AuthModule sử dụng
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthRateLimit.name, schema: AuthRateLimitSchema },
      {
        name: AuthSession.name,
        schema: AuthSessionSchema,
      },
      {
        name: AuthAuditEvent.name,
        schema: AuthAuditEventSchema,
      },
      {
        name: OAuthIdentity.name,
        schema: OAuthIdentitySchema,
      },
      {
        name: GoogleOAuthTransaction.name,
        schema: GoogleOAuthTransactionSchema,
      },
      {
        name: GoogleOAuthContinuationGrant.name,
        schema: GoogleOAuthContinuationGrantSchema,
      },
      {
        name: GoogleOAuthSessionHandoff.name,
        schema: GoogleOAuthSessionHandoffSchema,
      },
    ]),
    PassportModule,
    // Cấu hình JwtModule động từ file .env
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        // signOptions: { expiresIn: '1d' }, // Mặc định giá trị nếu Không ghi đè
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [
    AuthController,
    AuthSessionsController,
    GoogleOAuthAuthorizationController,
    GoogleOAuthCallbackController,
    GoogleOAuthSessionController,
    GoogleOAuthContinuationController,
    GoogleOAuthAccountController,
  ],
  providers: [
    AuthService,
    AuthSessionService,
    AuthRateLimitService,
    AuthAuditService,
    JwtStrategy,
    MailService,
    OAuthIdentityService,
    GoogleOAuthTransactionService,
    GoogleOAuthClientFactory,
    GoogleOAuthProviderService,
    GoogleOAuthAccountResolverService,
    GoogleOAuthContinuationGrantService,
    GoogleOAuthAccountLinkService,
    GoogleOAuthAccountUnlinkService,
    GoogleOAuthRegistrationService,
    GoogleOAuthContinuationCookieService,
    GoogleOAuthContinuationOriginGuard,
    GoogleOAuthSessionHandoffCookieService,
    GoogleOAuthSessionHandoffService,
    GoogleOAuthSignInService,
    GoogleOAuthCallbackService,
    GoogleOAuthFrontendRedirectService,
    GoogleOAuthStateCookieService,
  ],
  exports: [AuthSessionService, AuthAuditService, OAuthIdentityService],
})
export class AuthModule {}
