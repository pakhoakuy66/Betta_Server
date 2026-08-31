import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { AccessSupportCryptoService } from '../../reports/services/access-support-crypto.service';
import {
  SystemReport,
  SystemReportSource,
  SystemReportType,
} from '../../reports/schemas/system-report.schema';
import {
  ADMIN_ACCESS_SUPPORT_CONTACT_DECRYPT_FAILED_MESSAGE,
  ADMIN_ACCESS_SUPPORT_CONTACT_NOT_FOUND_MESSAGE,
  ADMIN_ACCESS_SUPPORT_CONTACT_REASON_PATTERN,
} from '../constants/admin-access-support-contact.constants';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import {
  type IssueAdminAccessSupportContactReauthInput,
  type PublicAdminAccessSupportContact,
  type RevealAdminAccessSupportContactInput,
} from '../interfaces/admin-access-support-contact.interface';
import { AdminAuditService } from './admin-audit.service';
import { AdminReauthService } from './admin-reauth.service';

type StoredAccessSupportContact = Readonly<{
  publicId: string;
  encryptedContactEmail: string;
}>;

type ContactTransactionResult =
  | Readonly<{ ok: true; contactEmail: string }>
  | Readonly<{ ok: false }>;

@Injectable()
export class AdminAccessSupportContactService {
  constructor(
    @InjectModel(SystemReport.name)
    private readonly reports: Model<SystemReport>,
    @InjectConnection() private readonly connection: Connection,
    private readonly crypto: AccessSupportCryptoService,
    private readonly reauth: AdminReauthService,
    private readonly audit: AdminAuditService,
  ) {}

  async issueReauth(input: IssueAdminAccessSupportContactReauthInput) {
    this.assertActor(input.actor);
    await this.assertRevealable(input.reportPublicId);

    return this.reauth.issue({
      adminAccountId: input.actor.adminAccountId,
      adminPublicId: input.actor.publicId,
      sessionPublicId: input.actor.sessionPublicId,
      password: input.password,
      totpToken: input.totpToken,
      purpose: AdminReauthPurpose.REPORT_CONTACT_REVEAL,
      targetPublicId: input.reportPublicId,
      trustedClientIp: input.trustedClientIp,
      actor: input.actor,
      source: input.source,
    });
  }

  async reveal(
    input: RevealAdminAccessSupportContactInput,
  ): Promise<PublicAdminAccessSupportContact> {
    this.assertActor(input.actor);
    this.assertRevealInput(input);

    try {
      const result = await this.connection.transaction(
        async (mongoSession): Promise<ContactTransactionResult> => {
          const report = await this.loadContact(
            input.reportPublicId,
            mongoSession,
          );
          if (!report) this.notFound();

          await this.reauth.consumeInTransaction({
            rawGrant: input.reauthGrant,
            adminAccountId: input.actor.adminAccountId,
            adminPublicId: input.actor.publicId,
            sessionPublicId: input.actor.sessionPublicId,
            credentialVersion: input.actor.credentialVersion,
            authzVersion: input.actor.authzVersion,
            permissionVersion: input.actor.permissionVersion,
            purpose: AdminReauthPurpose.REPORT_CONTACT_REVEAL,
            targetPublicId: input.reportPublicId,
            actor: input.actor,
            source: input.source,
            mongoSession,
          });

          let contactEmail: string;
          try {
            contactEmail = this.crypto.decrypt(
              report.encryptedContactEmail,
              report.publicId,
              'contactEmail',
            );
          } catch {
            await this.recordRevealAudit(
              input,
              AdminAuditOutcome.FAILED,
              mongoSession,
            );
            return Object.freeze({ ok: false });
          }

          await this.recordRevealAudit(
            input,
            AdminAuditOutcome.SUCCEEDED,
            mongoSession,
          );
          return Object.freeze({ ok: true, contactEmail });
        },
      );

      if (!result.ok) {
        throw new ServiceUnavailableException(
          ADMIN_ACCESS_SUPPORT_CONTACT_DECRYPT_FAILED_MESSAGE,
        );
      }

      return Object.freeze({
        reportPublicId: input.reportPublicId,
        contactEmail: result.contactEmail,
      });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        await this.recordDenied(input);
      }
      if (error instanceof HttpException) throw error;
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Dịch vụ contact access-support tạm thời không khả dụng',
        );
      }
      throw error;
    }
  }

  private async assertRevealable(reportPublicId: string): Promise<void> {
    try {
      const exists = await this.reports.exists({
        publicId: reportPublicId,
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        encryptedContactEmail: { $type: 'string' },
        evidencePurgedAt: null,
      });
      if (!exists) this.notFound();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Dịch vụ contact access-support tạm thời không khả dụng',
        );
      }
      throw error;
    }
  }

  private loadContact(
    reportPublicId: string,
    mongoSession: ClientSession,
  ): Promise<StoredAccessSupportContact | null> {
    return this.reports
      .findOne({
        publicId: reportPublicId,
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        encryptedContactEmail: { $type: 'string' },
        evidencePurgedAt: null,
      })
      .select('publicId +encryptedContactEmail')
      .session(mongoSession)
      .lean<StoredAccessSupportContact | null>()
      .exec();
  }

  private recordRevealAudit(
    input: RevealAdminAccessSupportContactInput,
    outcome: AdminAuditOutcome,
    mongoSession: ClientSession,
  ): Promise<string> {
    return this.audit.record({
      action: AdminAuditAction.CONTACT_REVEALED,
      outcome,
      actor: input.actor,
      target: {
        type: AdminAuditTargetType.SYSTEM_REPORT,
        publicId: input.reportPublicId,
      },
      reasonCode: input.reason,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      source: input.source,
      mongoSession,
    });
  }

  private async recordDenied(
    input: RevealAdminAccessSupportContactInput,
  ): Promise<void> {
    await this.connection.transaction(async (mongoSession) => {
      await this.recordRevealAudit(
        input,
        AdminAuditOutcome.DENIED,
        mongoSession,
      );
    });
  }

  private assertActor(
    actor: IssueAdminAccessSupportContactReauthInput['actor'],
  ): void {
    if (
      actor.role !== AdminRole.SUPER_ADMIN ||
      actor.permission !== AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW ||
      !Types.ObjectId.isValid(actor.adminAccountId)
    ) {
      throw new ForbiddenException('Không có quyền xem contact access-support');
    }
  }

  private assertRevealInput(input: RevealAdminAccessSupportContactInput): void {
    if (!ADMIN_ACCESS_SUPPORT_CONTACT_REASON_PATTERN.test(input.reason)) {
      throw new TypeError('Reason contact reveal không hợp lệ');
    }
  }

  private notFound(): never {
    throw new NotFoundException(ADMIN_ACCESS_SUPPORT_CONTACT_NOT_FOUND_MESSAGE);
  }
}
