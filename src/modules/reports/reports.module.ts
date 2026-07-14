import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { ReportRateLimitExceptionFilter } from './filters/report-rate-limit-exception.filter';
import { ReportStatusTransitionService } from './services/report-status-transition.service';

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
    ]),
  ],
  providers: [
    ReportsService,
    ReportRateLimitService,
    ReportIssueUploadRateLimitGuard,
    ReportStatusTransitionService,
    {
      provide: APP_FILTER,
      useClass: ReportRateLimitExceptionFilter,
    },
  ],
  controllers: [ReportsController],
  exports: [ReportStatusTransitionService],
})
export class ReportsModule {}
