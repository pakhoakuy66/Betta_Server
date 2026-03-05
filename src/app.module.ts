import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { PostsModule } from './modules/posts/posts.module';
import { RecapModule } from './modules/recap/recap.module';
import { StreakModule } from './modules/streak/streak.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [AuthModule, PostsModule, RecapModule, StreakModule, NotificationsModule, ReportsModule, UploadsModule, UsersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
