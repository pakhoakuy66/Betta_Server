import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UploadsModule } from '../uploads/uploads.module';
import { StreakModule } from '../streak/streak.module';
import { RecapModule } from '../recap/recap.module';
import { ReactionModule } from '../reactions/reaction.module';
import { TasksService } from './services/tasks.service';
import { ExpiredPostCleanupService } from './services/expired-post-cleanup.service';
import { AdminModule } from '../admin/admin.module';
import { Report, ReportSchema } from '../reports/schemas/report.schema';
import { PostModerationCleanupHandler } from './services/post-moderation-cleanup.handler';

@Module({
  imports: [
    AdminModule,
    StreakModule,
    RecapModule,
    ReactionModule,
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Report.name, schema: ReportSchema },
    ]),
    UploadsModule,
  ],
  providers: [
    TasksService,
    ExpiredPostCleanupService,
    PostModerationCleanupHandler,
  ],
})
export class CronModule {}
