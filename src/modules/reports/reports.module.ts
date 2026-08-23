import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportsService } from './services/reports.service';
import { ReportRateLimitService } from './services/report-rate-limit.service';
import { ReportsController } from './controllers/reports.controller';
import { Report, ReportSchema } from './schemas/report.schema';
import {
  SystemReport,
  SystemReportSchema,
} from './schemas/system-report.schema';
import {
  ReportCooldown,
  ReportCooldownSchema,
} from './schemas/report-cooldown.schema';
import {
  ReportRateLimit,
  ReportRateLimitSchema,
} from './schemas/report-rate-limit.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';
import { UploadsModule } from '../uploads/uploads.module';
import { ReportIssueUploadRateLimitGuard } from './guards/report-issue-upload-rate-limit.guard';
import { ReportStatusTransitionService } from './services/report-status-transition.service';
import { AccessSupportSecretsConfig } from './config/access-support-secrets.config';
import { AccessSupportCryptoService } from './services/access-support-crypto.service';
import { AccessSupportRateLimitService } from './services/access-support-rate-limit.service';
import { AccessSupportService } from './services/access-support.service';
import { AccessSupportBodyLimitGuard } from './guards/access-support-body-limit.guard';
import {
  AccessSupportDedupe,
  AccessSupportDedupeSchema,
} from './schemas/access-support-dedupe.schema';
import { AccessSupportDedupeService } from './services/access-support-dedupe.service';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: SystemReport.name, schema: SystemReportSchema },
      { name: ReportCooldown.name, schema: ReportCooldownSchema },
      { name: ReportRateLimit.name, schema: ReportRateLimitSchema },
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
      { name: AccessSupportDedupe.name, schema: AccessSupportDedupeSchema },
    ]),
  ],
  providers: [
    ReportsService,
    ReportRateLimitService,
    ReportIssueUploadRateLimitGuard,
    ReportStatusTransitionService,
    AccessSupportSecretsConfig,
    AccessSupportCryptoService,
    AccessSupportRateLimitService,
    AccessSupportService,
    AccessSupportBodyLimitGuard,
    AccessSupportDedupeService,
  ],
  controllers: [ReportsController],
  exports: [ReportStatusTransitionService],
})
export class ReportsModule {}
