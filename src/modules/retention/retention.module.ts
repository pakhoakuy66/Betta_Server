import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UploadsModule } from '../uploads/uploads.module';
import {
  SystemReport,
  SystemReportSchema,
} from '../reports/schemas/system-report.schema';
import { DataRetentionService } from './data-retention.service';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: SystemReport.name, schema: SystemReportSchema },
    ]),
  ],
  providers: [DataRetentionService],
  exports: [DataRetentionService],
})
export class RetentionModule {}
