import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportsService } from './services/reports.service';
import { ReportsController } from './controllers/reports.controller';
import { Report, ReportSchema } from './schemas/report.schema';
import {
  SystemReport,
  SystemReportSchema,
} from './schemas/system-report.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';
import {
  ReportCooldown,
  ReportCooldownSchema,
} from './schemas/report-cooldown.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: SystemReport.name, schema: SystemReportSchema },
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
      { name: ReportCooldown.name, schema: ReportCooldownSchema },
    ]),
  ],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
