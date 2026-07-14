import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecapService } from './services/recap.service';
import { WeeklyRecapJobService } from './services/weekly-recap-job.service';
import { RecapController } from './controllers/recap.controller';
import {
  EngagementEvent,
  EngagementEventSchema,
} from './schemas/engagement-event.schema';
import { WeeklyRecap, WeeklyRecapSchema } from './schemas/recap.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  WeeklyRecapRun,
  WeeklyRecapRunSchema,
} from './schemas/weekly-recap-run.schema';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: EngagementEvent.name, schema: EngagementEventSchema },
      { name: WeeklyRecap.name, schema: WeeklyRecapSchema },
      { name: User.name, schema: UserSchema },
      { name: WeeklyRecapRun.name, schema: WeeklyRecapRunSchema },
    ]),
  ],
  providers: [RecapService, WeeklyRecapJobService],
  controllers: [RecapController],
  exports: [RecapService, WeeklyRecapJobService],
})
export class RecapModule {}
