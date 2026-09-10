import { SponsoredLifecycleController } from '../sponsored-posts/sponsored-lifecycle.controller';
import { SponsoredPostMutationController } from '../sponsored-posts/sponsored-post-mutation.controller';
import { Module } from '@nestjs/common';
import { SponsoredPostQueryController } from '../sponsored-posts/sponsored-post-query.controller';
import { SponsoredPostsModule } from '../sponsored-posts/sponsored-posts.module';
import { SponsoredMediaController } from '../sponsored-posts/sponsored-media.controller';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { OutboxModule } from '../../common/outbox/outbox.module';
import {
  AuthSession,
  AuthSessionSchema,
} from '../auth/schemas/auth-session.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { AccessSupportSecurityModule } from '../reports/access-support-security.module';
import { Report, ReportSchema } from '../reports/schemas/report.schema';
import {
  SystemReport,
  SystemReportSchema,
} from '../reports/schemas/system-report.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
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
import { ADMIN_USER_RESTRICTION_EXPIRY_CLOCK_PROVIDER } from './constants/admin-user-restriction-expiry.constants';
import { ADMIN_REPORT_DECISION_FAILURE_INJECTOR } from './constants/admin-report-decision.constants';
import { ADMIN_POST_MODERATION_FAILURE_INJECTOR } from './constants/admin-post-moderation.constants';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AdminAccountLifecycleController } from './controllers/admin-account-lifecycle.controller';
import { AdminAccountQueryController } from './controllers/admin-account-query.controller';
import { AdminAccountStatusController } from './controllers/admin-account-status.controller';
import { AdminAccountDeletionController } from './controllers/admin-account-deletion.controller';
import { AdminReportAssignmentController } from './controllers/admin-report-assignment.controller';
import { AdminReportDecisionController } from './controllers/admin-report-decision.controller';
import { AdminReportQueueController } from './controllers/admin-report-queue.controller';
import { AdminAccessSupportContactController } from './controllers/admin-access-support-contact.controller';
import { AdminPostModerationDetailController } from './controllers/admin-post-moderation-detail.controller';
import { AdminPostModerationController } from './controllers/admin-post-moderation.controller';
import { AdminUserQueryController } from './controllers/admin-user-query.controller';
import { AdminUserRestrictionController } from './controllers/admin-user-restriction.controller';
import { AdminUserDeletionController } from './controllers/admin-user-deletion.controller';
import { AdminUserModerationHistoryController } from './controllers/admin-user-moderation-history.controller';
import { AdminActivationController } from './controllers/admin-activation.controller';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminAuthOriginGuard } from './guards/admin-auth-origin.guard';
import { AdminCsrfGuard } from './guards/admin-csrf.guard';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { AdminAccountStatusPermissionGuard } from './guards/admin-account-status-permission.guard';
import { AdminAccountDeletionPermissionGuard } from './guards/admin-account-deletion-permission.guard';
import { AdminUserRestrictionPermissionGuard } from './guards/admin-user-restriction-permission.guard';
import { AdminUserDeletionPermissionGuard } from './guards/admin-user-deletion-permission.guard';
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
import { AdminUserQueryService } from './services/admin-user-query.service';
import { AdminUserAccessLogger } from './services/admin-user-access-logger.service';
import {
  AdminUserRestrictionRequest,
  AdminUserRestrictionRequestSchema,
} from './schemas/admin-user-restriction-request.schema';
import { AdminUserRestrictionService } from './services/admin-user-restriction.service';
import { AdminUserRestrictionExpiryService } from './services/admin-user-restriction-expiry.service';
import {
  AdminUserDeletionRequest,
  AdminUserDeletionRequestSchema,
} from './schemas/admin-user-deletion-request.schema';
import { AdminUserDeletionService } from './services/admin-user-deletion.service';
import {
  AdminReportAssignmentRequest,
  AdminReportAssignmentRequestSchema,
} from './schemas/admin-report-assignment-request.schema';
import { AdminReportAccessLogger } from './services/admin-report-access-logger.service';
import { AdminReportAssignmentService } from './services/admin-report-assignment.service';
import { AdminReportDecisionService } from './services/admin-report-decision.service';
import { AdminReportDecisionOutboxHandler } from './services/admin-report-decision-outbox.handler';
import { AdminReportTargetMutationService } from './services/admin-report-target-mutation.service';
import { AdminReportQueueService } from './services/admin-report-queue.service';
import { AdminAccessSupportContactService } from './services/admin-access-support-contact.service';
import { AdminPostModerationAccessLogger } from './services/admin-post-moderation-access-logger.service';
import { AdminPostModerationDetailService } from './services/admin-post-moderation-detail.service';
import { AdminPostLifecycleService } from './services/admin-post-lifecycle.service';
import { AdminPostModerationService } from './services/admin-post-moderation.service';
import { AdminUserModerationHistoryService } from './services/admin-user-moderation-history.service';
import {
  AdminReportDecisionRequest,
  AdminReportDecisionRequestSchema,
} from './schemas/admin-report-decision-request.schema';
import {
  ModerationDecision,
  ModerationDecisionSchema,
} from './schemas/moderation-decision.schema';
import {
  AdminPostModerationRequest,
  AdminPostModerationRequestSchema,
} from './schemas/admin-post-moderation-request.schema';

@Module({
  imports: [
    SponsoredPostsModule,
    ConfigModule,
    AccessSupportSecurityModule,
    OutboxModule,
    PassportModule,
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthSession.name, schema: AuthSessionSchema },
      { name: Report.name, schema: ReportSchema },
      { name: SystemReport.name, schema: SystemReportSchema },
      { name: Post.name, schema: PostSchema },
      { name: ModerationDecision.name, schema: ModerationDecisionSchema },
      {
        name: AdminPostModerationRequest.name,
        schema: AdminPostModerationRequestSchema,
      },
      {
        name: AdminReportDecisionRequest.name,
        schema: AdminReportDecisionRequestSchema,
      },
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
      {
        name: AdminReportAssignmentRequest.name,
        schema: AdminReportAssignmentRequestSchema,
      },
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
      {
        name: AdminUserRestrictionRequest.name,
        schema: AdminUserRestrictionRequestSchema,
      },
      {
        name: AdminUserDeletionRequest.name,
        schema: AdminUserDeletionRequestSchema,
      },
    ]),
  ],
  controllers: [
    SponsoredPostMutationController,
    SponsoredLifecycleController,
    SponsoredPostQueryController,
    SponsoredMediaController,
    AdminPostModerationController,
    AdminPostModerationDetailController,
    AdminReportAssignmentController,
    AdminReportDecisionController,
    AdminReportQueueController,
    AdminAccessSupportContactController,
    AdminUserQueryController,
    AdminAuditController,
    AdminAuthController,
    AdminActivationController,
    AdminAccountLifecycleController,
    AdminAccountQueryController,
    AdminAccountStatusController,
    AdminAccountDeletionController,
    AdminUserRestrictionController,
    AdminUserDeletionController,
    AdminUserModerationHistoryController,
  ],
  providers: [
    {
      provide: ADMIN_POST_MODERATION_FAILURE_INJECTOR,
      useValue: Object.freeze({ hit: () => undefined }),
    },
    {
      provide: ADMIN_REPORT_DECISION_FAILURE_INJECTOR,
      useValue: Object.freeze({ hit: () => undefined }),
    },
    AdminPostModerationAccessLogger,
    AdminPostModerationDetailService,
    AdminPostLifecycleService,
    AdminPostModerationService,
    AdminReportAssignmentService,
    AdminReportDecisionService,
    AdminReportDecisionOutboxHandler,
    AdminReportTargetMutationService,
    AdminReportQueueService,
    AdminAccessSupportContactService,
    AdminReportAccessLogger,
    AdminUserQueryService,
    AdminUserAccessLogger,
    ADMIN_POLICY_PROVIDER,
    AUTH_SECRET_MATERIAL_BOUNDARY_PROVIDER,
    ADMIN_SECRETS_PROVIDER,
    ADMIN_AUTHORIZATION_CLOCK_PROVIDER,
    ADMIN_USER_RESTRICTION_EXPIRY_CLOCK_PROVIDER,
    AdminAccessTokenService,
    AdminAuthorizationStateService,
    AdminAuditService,
    AdminSessionService,
    AdminJwtStrategy,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    AdminAccountStatusPermissionGuard,
    AdminAccountDeletionPermissionGuard,
    AdminUserRestrictionPermissionGuard,
    AdminUserDeletionPermissionGuard,
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
    AdminUserRestrictionService,
    AdminUserRestrictionExpiryService,
    AdminUserDeletionService,
    AdminUserModerationHistoryService,
    {
      provide: ADMIN_RECOVERY_SECRET_STORE,
      useClass: AdminRecoveryCommandSecretStore,
    },
  ],
  exports: [
    MongooseModule,
    AdminPostModerationDetailService,
    AdminPostLifecycleService,
    AdminPostModerationService,
    AdminReportAssignmentService,
    AdminReportDecisionService,
    AdminReportTargetMutationService,
    AdminReportQueueService,
    AdminAccessSupportContactService,
    AdminUserQueryService,
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
    AdminUserRestrictionService,
    AdminUserRestrictionExpiryService,
    AdminUserDeletionService,
    AdminUserModerationHistoryService,
  ],
})
export class AdminModule {}
