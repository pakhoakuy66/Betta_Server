import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UploadsModule } from '../uploads/uploads.module';
import {
  SystemReport,
  SystemReportSchema,
} from '../reports/schemas/system-report.schema';
import { Report, ReportSchema } from '../reports/schemas/report.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { DataRetentionService } from './data-retention.service';
import { ReportEvidenceRetentionService } from './report-evidence-retention.service';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: SystemReport.name, schema: SystemReportSchema },
      { name: Report.name, schema: ReportSchema },
      { name: Post.name, schema: PostSchema },
    ]),
  ],
  providers: [DataRetentionService, ReportEvidenceRetentionService],
  exports: [DataRetentionService, ReportEvidenceRetentionService],
})
export class RetentionModule {}
