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
import { ADMIN_AUTHORIZATION_CLOCK_PROVIDER } from './constants/admin-authorization-state.constants';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AdminAccountLifecycleController } from './controllers/admin-account-lifecycle.controller';
import { AdminAccountQueryController } from './controllers/admin-account-query.controller';
import { AdminAccountStatusController } from './controllers/admin-account-status.controller';
import { AdminAccountDeletionController } from './controllers/admin-account-deletion.controller';
import { AdminActivationController } from './controllers/admin-activation.controller';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminAuthOriginGuard } from './guards/admin-auth-origin.guard';
import { AdminCsrfGuard } from './guards/admin-csrf.guard';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { AdminAccountStatusPermissionGuard } from './guards/admin-account-status-permission.guard';
import { AdminAccountDeletionPermissionGuard } from './guards/admin-account-deletion-permission.guard';
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
  AdminBootstrapState,
  AdminBootstrapStateSchema,
} from './schemas/admin-bootstrap-state.schema';
import {
  AdminLoginProtection,
  AdminLoginProtectionSchema,
} from './schemas/admin-login-protection.schema';
import { AdminLoginProtectionService } from './services/admin-login-protection.service';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminAuthCookieService } from './services/admin-auth-cookie.service';
import { AdminMfaCryptoService } from './services/admin-mfa-crypto.service';
import { AdminMfaService } from './services/admin-mfa.service';
import { AdminAccessTokenService } from './services/admin-access-token.service';
import { AdminAuthorizationStateService } from './services/admin-authorization-state.service';
import { AdminAuditService } from './services/admin-audit.service';
import { AdminSessionService } from './services/admin-session.service';
import { AdminCredentialService } from './services/admin-credential.service';
import { AdminReauthService } from './services/admin-reauth.service';
import { AdminAccountRecoveryService } from './services/admin-account-recovery.service';
import { AdminRecoveryCommandSecretStore } from './services/admin-recovery-command-secret-store.service';
import { ADMIN_RECOVERY_SECRET_STORE } from './interfaces/admin-account-recovery.interface';
import {
  AdminRecoveryGrant,
  AdminRecoveryGrantSchema,
} from './schemas/admin-recovery-grant.schema';
import {
  AdminReauthGrant,
  AdminReauthGrantSchema,
} from './schemas/admin-reauth-grant.schema';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminActivationService } from './services/admin-activation.service';
import { AdminAccountLifecycleService } from './services/admin-account-lifecycle.service';
import { AdminAccountQueryService } from './services/admin-account-query.service';
import { AdminBootstrapCommandSecretStore } from './services/admin-bootstrap-command-secret-store.service';
import { ADMIN_BOOTSTRAP_SECRET_STORE } from './interfaces/admin-bootstrap.interface';
import {
  AdminAccountCreationRequest,
  AdminAccountCreationRequestSchema,
} from './schemas/admin-account-creation-request.schema';
import {
  AdminLifecycleCoordinator,
  AdminLifecycleCoordinatorSchema,
} from './schemas/admin-lifecycle-coordinator.schema';
import { AdminAccountStatusService } from './services/admin-account-status.service';
import { AdminAccountDeletionService } from './services/admin-account-deletion.service';
import { AdminLastSuperAdminInvariantService } from './services/admin-last-super-admin-invariant.service';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
      { name: AdminSession.name, schema: AdminSessionSchema },
      { name: AdminBootstrapState.name, schema: AdminBootstrapStateSchema },
      { name: AdminRecoveryGrant.name, schema: AdminRecoveryGrantSchema },
      { name: AdminReauthGrant.name, schema: AdminReauthGrantSchema },
      {
        name: AdminAccountCreationRequest.name,
        schema: AdminAccountCreationRequestSchema,
      },
      {
        name: AdminLifecycleCoordinator.name,
        schema: AdminLifecycleCoordinatorSchema,
      },
      {
        name: AdminLoginProtection.name,
        schema: AdminLoginProtectionSchema,
      },
    ]),
  ],
  controllers: [
    AdminAuditController,
    AdminAuthController,
    AdminActivationController,
    AdminAccountLifecycleController,
    AdminAccountQueryController,
    AdminAccountStatusController,
    AdminAccountDeletionController,
  ],
  providers: [
    ADMIN_POLICY_PROVIDER,
    AUTH_SECRET_MATERIAL_BOUNDARY_PROVIDER,
    ADMIN_SECRETS_PROVIDER,
    ADMIN_AUTHORIZATION_CLOCK_PROVIDER,
    AdminAccessTokenService,
    AdminAuthorizationStateService,
    AdminAuditService,
    AdminSessionService,
    AdminJwtStrategy,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    AdminAccountStatusPermissionGuard,
    AdminAccountDeletionPermissionGuard,
    AdminLoginProtectionService,
    AdminMfaCryptoService,
    AdminMfaService,
    AdminAuthService,
    AdminAuthCookieService,
    AdminAuthOriginGuard,
    AdminCsrfGuard,
    AdminCredentialService,
    AdminReauthService,
    AdminAccountRecoveryService,
    AdminActivationService,
    AdminBootstrapCommandSecretStore,
    {
      provide: ADMIN_BOOTSTRAP_SECRET_STORE,
      useExisting: AdminBootstrapCommandSecretStore,
    },
    AdminAccountLifecycleService,
    AdminAccountQueryService,
    AdminAccountStatusService,
    AdminAccountDeletionService,
    AdminLastSuperAdminInvariantService,
    {
      provide: ADMIN_RECOVERY_SECRET_STORE,
      useClass: AdminRecoveryCommandSecretStore,
    },
  ],
  exports: [
    MongooseModule,
    ADMIN_POLICY,
    ADMIN_SECRETS,
    AdminAuthorizationStateService,
    AdminAuditService,
    AdminSessionService,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    AdminLoginProtectionService,
    AdminMfaService,
    AdminAuthService,
    AdminAuthCookieService,
    AdminCredentialService,
    AdminReauthService,
    AdminAccountRecoveryService,
    AdminActivationService,
    ADMIN_BOOTSTRAP_SECRET_STORE,
    AdminAccountLifecycleService,
    AdminAccountQueryService,
    AdminAccountStatusService,
    AdminAccountDeletionService,
    AdminLastSuperAdminInvariantService,
  ],
})
export class AdminModule {}
