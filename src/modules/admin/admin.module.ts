import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import {
  ADMIN_POLICY,
  ADMIN_POLICY_PROVIDER,
} from './config/admin-policy.config';
import {
  ADMIN_SECRETS,
  ADMIN_SECRETS_PROVIDER,
} from './config/admin-secrets.config';
import { AUTH_SECRET_MATERIAL_BOUNDARY_PROVIDER } from './config/auth-secret-material-boundary.config';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import {
  AdminAccount,
  AdminAccountSchema,
} from './schemas/admin-account.schema';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from './schemas/admin-audit-event.schema';
import {
  AdminSession,
  AdminSessionSchema,
} from './schemas/admin-session.schema';
import {
  AdminLoginProtection,
  AdminLoginProtectionSchema,
} from './schemas/admin-login-protection.schema';
import { AdminLoginProtectionService } from './services/admin-login-protection.service';
import { AdminMfaCryptoService } from './services/admin-mfa-crypto.service';
import { AdminMfaService } from './services/admin-mfa.service';
import { AdminAccessTokenService } from './services/admin-access-token.service';
import { AdminAuditService } from './services/admin-audit.service';
import { AdminSessionService } from './services/admin-session.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
      { name: AdminSession.name, schema: AdminSessionSchema },
      {
        name: AdminLoginProtection.name,
        schema: AdminLoginProtectionSchema,
      },
    ]),
  ],
  controllers: [AdminAuditController],
  providers: [
    ADMIN_POLICY_PROVIDER,
    AUTH_SECRET_MATERIAL_BOUNDARY_PROVIDER,
    ADMIN_SECRETS_PROVIDER,
    AdminAccessTokenService,
    AdminAuditService,
    AdminSessionService,
    AdminJwtStrategy,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    AdminLoginProtectionService,
    AdminMfaCryptoService,
    AdminMfaService,
  ],
  exports: [
    MongooseModule,
    ADMIN_POLICY,
    ADMIN_SECRETS,
    AdminAuditService,
    AdminSessionService,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    AdminLoginProtectionService,
    AdminMfaService,
  ],
})
export class AdminModule {}
