import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UploadsModule } from '../uploads/uploads.module';
import { StreakModule } from '../streak/streak.module';
import { TasksService } from './services/tasks.service';
import { ExpiredPostCleanupService } from './services/expired-post-cleanup.service';

@Module({
  imports: [
    StreakModule,
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
    ]),
    UploadsModule,
  ],
  providers: [TasksService, ExpiredPostCleanupService],
})
export class CronModule {}
