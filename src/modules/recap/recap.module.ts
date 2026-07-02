import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecapService } from './services/recap.service';
import { RecapController } from './controllers/recap.controller';
import {
  EngagementEvent,
  EngagementEventSchema,
} from './schemas/engagement-event.schema';
import { WeeklyRecap, WeeklyRecapSchema } from './schemas/recap.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EngagementEvent.name, schema: EngagementEventSchema },
      { name: WeeklyRecap.name, schema: WeeklyRecapSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [RecapService],
  controllers: [RecapController],
  exports: [RecapService],
})
export class RecapModule {}
